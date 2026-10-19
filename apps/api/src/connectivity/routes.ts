/**
 * Connectivity: pair/unpair Telegram and WhatsApp, event preferences, test message and delivery records.
 *
 * Pairing is a single-use code, like the Telegram sign-in: the signed-in owner/admin creates a code (shown once, stored
 * only as a keyed digest, bound to account + user + channel), sends it to the bot/number from their channel account, then
 * confirms. The first channel sender of an unexpired code claims it; confirm consumes it exactly once (one conditional
 * UPDATE) and creates the binding. Replays, other accounts/users, wrong channel and expired codes all fail the same way.
 *
 * Real Telegram/WhatsApp delivery is BLOCKED (no credentials). Only Fake providers exist; without a registered provider a
 * channel answers 503 and reports mode "unconfigured".
 */
import { randomInt } from "node:crypto";
import { Hono } from "hono";
import {
  Binding, BindingList, ChannelStatusList, ConfirmPairingRequest, CreatePairingRequest, DeliveryList, DeliveryQuery,
  PairingCode, TestNotificationAccepted, UpdateBindingRequest, type NotificationChannel, type NotificationEventKind,
} from "@llmcrypto/contracts";
import { enqueueNotification, canManageProjects, type ChannelProvider, type ChannelRegistry } from "@llmcrypto/domain";
import { audit } from "../audit";
import { requireRecentSignIn, requireSecret, requireSession, type AuthContext } from "../auth/session";
import type { AppConfig } from "../config";
import { hmacHex, randomId } from "../crypto";
import { decodeCursor, encodeCursor } from "../cursor";
import type { Db } from "../db";
import { ApiError, parseWith, type AppEnv, type Ctx } from "../http";

export interface ConnectivityDeps {
  db: Db;
  config: AppConfig;
  channels: ChannelRegistry;
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8; // 40 bits
const PAIRING_TTL_SECONDS = 600;
const MAX_ACTIVE_PAIRINGS = 5;
const MAX_CONFIRM_ATTEMPTS = 30;
const SENDER: Record<NotificationChannel, RegExp> = { telegram: /^[0-9]{1,20}$/, whatsapp: /^[1-9][0-9]{6,14}$/ };

const normalizeCode = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const mask = (dest: string): string => `••••${dest.slice(-4)}`;

interface BindingRow {
  id: string;
  channel: NotificationChannel;
  destination: string;
  events: NotificationEventKind[];
  created_at: Date;
}
const toBinding = (r: BindingRow): Binding => ({ id: r.id, channel: r.channel, destination: mask(r.destination), events: r.events, createdAt: r.created_at.toISOString() });

function requireManager(auth: AuthContext): void {
  if (!canManageProjects(auth.role)) throw new ApiError("FORBIDDEN", "Operation not permitted for your role");
}
const invalidPairing = (): ApiError =>
  new ApiError("VALIDATION_FAILED", "Request validation failed", [{ field: "pairing", message: "Code is expired, already used, or has not been sent to the channel yet" }]);

/** Optional JSON body: an empty body is {}. */
async function optionalBody(c: Ctx, schema: typeof ConfirmPairingRequest) {
  const text = await c.req.text();
  if (text.trim() === "") return schema.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError("BAD_REQUEST", "Malformed JSON body");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError("BAD_REQUEST", "Body must be a JSON object");
  const r = schema.safeParse(raw);
  if (!r.success) throw new ApiError("VALIDATION_FAILED", "Request validation failed", r.error.issues.map((i) => ({ field: i.path.join(".") || "(body)", message: i.message })));
  return r.data;
}

export function connectivityRoutes({ db, config, channels }: ConnectivityDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireSession(db, config));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  const digest = (channel: NotificationChannel, code: string): string => hmacHex(requireSecret(config.sessionSecret, "SESSION_SECRET"), `pairing|${channel}|${normalizeCode(code)}`);
  const providerFor = (channel: NotificationChannel): ChannelProvider => {
    const p = channels[channel];
    if (!p) throw new ApiError("UNAVAILABLE", `${channel === "telegram" ? "Telegram" : "WhatsApp"} is not configured (no channel credentials)`);
    return p;
  };

  /** Pulls inbound channel messages and lets the first sender of each live code claim it. Unknown text is ignored. */
  async function ingest(channel: NotificationChannel, provider: ChannelProvider): Promise<void> {
    const now = config.now();
    for (const m of await provider.fetchInbound()) {
      if (!SENDER[channel].test(m.senderId)) continue;
      for (const token of m.text.slice(0, 200).split(/\s+/)) {
        const code = normalizeCode(token);
        if (code.length !== CODE_LENGTH) continue;
        await db.query(
          `update notification_pairings set claimed_destination=$3, claimed_at=$4
            where code_hash=$1 and channel=$2 and claimed_destination is null and consumed_at is null and expires_at > $4`,
          [digest(channel, code), channel, m.senderId, now],
        );
      }
    }
  }

  app.get("/channels", (c) => {
    requireManager(c.get("auth"));
    const item = (channel: NotificationChannel) => {
      const p = channels[channel];
      return p
        ? { channel, available: true, mode: p.isFake ? ("fake" as const) : ("live" as const), note: p.isFake ? "In-process test double: messages are recorded, never delivered to a real chat." : "Live provider." }
        : { channel, available: false, mode: "unconfigured" as const, note: "No channel credentials are configured; pairing is unavailable." };
    };
    return c.json(ChannelStatusList.parse({ items: [item("telegram"), item("whatsapp")] }));
  });

  app.post("/pairings", async (c) => {
    const auth = c.get("auth");
    requireManager(auth);
    requireRecentSignIn(auth, config);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError("BAD_REQUEST", "Malformed JSON body");
    }
    const body = parseWith(CreatePairingRequest, raw);
    providerFor(body.channel);
    const now = config.now();
    const [{ n } = { n: "0" }] = await db.query<{ n: string }>("select count(*)::text n from notification_pairings where account_id=$1 and consumed_at is null and expires_at > $2", [auth.accountId, now]);
    if (Number(n) >= MAX_ACTIVE_PAIRINGS) throw new ApiError("RATE_LIMITED", "Too many open pairing codes; use or wait for one to expire", undefined, { "Retry-After": "60" });
    const raw8 = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    const id = randomId("pair");
    const expiresAt = new Date(now.getTime() + PAIRING_TTL_SECONDS * 1000);
    await db.tx(async (q) => {
      await q.query(
        "insert into notification_pairings (id, account_id, user_id, channel, code_hash, created_at, expires_at) values ($1,$2,$3,$4,$5,$6,$7)",
        [id, auth.accountId, auth.userId, body.channel, digest(body.channel, raw8), now, expiresAt],
      );
      await audit(q, { accountId: auth.accountId, actorUserId: auth.userId, action: "connectivity.pairing_started", targetType: "notification_pairing", targetId: id, requestId: c.get("requestId"), at: now, metadata: { channel: body.channel } });
    });
    return c.json(PairingCode.parse({ pairingId: id, channel: body.channel, code: `${raw8.slice(0, 4)}-${raw8.slice(4)}`, expiresAt: expiresAt.toISOString() }), 201);
  });

  app.post("/pairings/:id/confirm", async (c) => {
    const auth = c.get("auth");
    requireManager(auth);
    const body = await optionalBody(c, ConfirmPairingRequest);
    const id = c.req.param("id");
    const now = config.now();
    const [p] = await db.query<{ channel: NotificationChannel }>("select channel from notification_pairings where id=$1 and account_id=$2 and user_id=$3", [id, auth.accountId, auth.userId]);
    if (!p) throw new ApiError("NOT_FOUND", "Pairing not found"); // other accounts' and other users' ids look the same
    await ingest(p.channel, providerFor(p.channel));
    // A confirm that finds nothing counts toward the cap; past it the code is dead (no unlimited guessing/polling).
    await db.query("update notification_pairings set attempts=attempts+1 where id=$1 and consumed_at is null", [id]);
    const binding = await db.tx(async (q) => {
      const rows = await q.query<{ channel: NotificationChannel; claimed_destination: string }>(
        `update notification_pairings set consumed_at=$2
          where id=$1 and account_id=$3 and user_id=$4 and consumed_at is null and expires_at > $2 and claimed_destination is not null and attempts <= $5
          returning channel, claimed_destination`,
        [id, now, auth.accountId, auth.userId, MAX_CONFIRM_ATTEMPTS],
      );
      const r = rows[0];
      if (!r) throw invalidPairing();
      const [dup] = await q.query("select 1 as x from notification_bindings where account_id=$1 and channel=$2 and destination=$3 and unpaired_at is null", [auth.accountId, r.channel, r.claimed_destination]);
      if (dup) throw new ApiError("VALIDATION_FAILED", "Request validation failed", [{ field: "pairing", message: "This channel account is already paired to your account" }]);
      const bindingId = randomId("bnd");
      const events = [...new Set(body.events ?? [])];
      await q.query(
        "insert into notification_bindings (id, account_id, paired_by_user_id, channel, destination, events, created_at) values ($1,$2,$3,$4,$5,$6::jsonb,$7)",
        [bindingId, auth.accountId, auth.userId, r.channel, r.claimed_destination, JSON.stringify(events), now],
      );
      await audit(q, { accountId: auth.accountId, actorUserId: auth.userId, action: "connectivity.paired", targetType: "notification_binding", targetId: bindingId, requestId: c.get("requestId"), at: now, metadata: { channel: r.channel, events: events.join(",") } });
      return toBinding({ id: bindingId, channel: r.channel, destination: r.claimed_destination, events, created_at: now });
    });
    return c.json(Binding.parse(binding), 201);
  });

  const BIND_COLS = "id, channel, destination, events, created_at";

  app.get("/bindings", async (c) => {
    const auth = c.get("auth");
    requireManager(auth);
    const rows = await db.query<BindingRow>(`select ${BIND_COLS} from notification_bindings where account_id=$1 and unpaired_at is null order by created_at, id`, [auth.accountId]);
    return c.json(BindingList.parse({ items: rows.map(toBinding) }));
  });

  async function ownBinding(auth: AuthContext, id: string): Promise<BindingRow> {
    const [r] = await db.query<BindingRow>(`select ${BIND_COLS} from notification_bindings where id=$1 and account_id=$2 and unpaired_at is null`, [id, auth.accountId]);
    if (!r) throw new ApiError("NOT_FOUND", "Binding not found");
    return r;
  }

  app.put("/bindings/:id", async (c) => {
    const auth = c.get("auth");
    requireManager(auth);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError("BAD_REQUEST", "Malformed JSON body");
    }
    const body = parseWith(UpdateBindingRequest, raw);
    const b = await ownBinding(auth, c.req.param("id"));
    const events = [...new Set(body.events)];
    const now = config.now();
    await db.tx(async (q) => {
      await q.query("update notification_bindings set events=$3::jsonb where id=$1 and account_id=$2 and unpaired_at is null", [b.id, auth.accountId, JSON.stringify(events)]);
      await audit(q, { accountId: auth.accountId, actorUserId: auth.userId, action: "connectivity.preferences_updated", targetType: "notification_binding", targetId: b.id, requestId: c.get("requestId"), at: now, metadata: { events: events.join(",") } });
    });
    return c.json(Binding.parse(toBinding({ ...b, events })));
  });

  app.delete("/bindings/:id", async (c) => {
    const auth = c.get("auth");
    requireManager(auth);
    const b = await ownBinding(auth, c.req.param("id"));
    const now = config.now();
    await db.tx(async (q) => {
      await q.query("update notification_bindings set unpaired_at=$3, unpaired_by_user_id=$4 where id=$1 and account_id=$2 and unpaired_at is null", [b.id, auth.accountId, now, auth.userId]);
      // Nothing queued for this destination is sent after the unpair.
      await q.query("update notification_deliveries set status='skipped', error_code='UNPAIRED', updated_at=$2 where binding_id=$1 and status='pending'", [b.id, now]);
      await audit(q, { accountId: auth.accountId, actorUserId: auth.userId, action: "connectivity.unpaired", targetType: "notification_binding", targetId: b.id, requestId: c.get("requestId"), at: now, metadata: { channel: b.channel } });
    });
    return c.body(null, 204);
  });

  app.post("/bindings/:id/test", async (c) => {
    const auth = c.get("auth");
    requireManager(auth);
    const b = await ownBinding(auth, c.req.param("id"));
    const now = config.now();
    const eventId = randomId("nev");
    const created = await enqueueNotification(db, { id: eventId, accountId: auth.accountId, kind: "test", bindingId: b.id, dedupeKey: `test:${b.id}:${Math.floor(now.getTime() / 60_000)}`, at: now });
    if (!created) throw new ApiError("RATE_LIMITED", "A test message was just queued; wait a minute", undefined, { "Retry-After": "60" });
    return c.json(TestNotificationAccepted.parse({ eventId, bindingId: b.id }), 202);
  });

  app.get("/deliveries", async (c) => {
    const auth = c.get("auth");
    requireManager(auth);
    const q = parseWith(DeliveryQuery, c.req.query());
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await db.query<{ id: string; binding_id: string; channel: NotificationChannel; event_kind: string; status: string; attempts: number; error_code: string | null; created_at: Date; sent_at: Date | null }>(
      `select id, binding_id, channel, event_kind, status, attempts, error_code, created_at, sent_at from notification_deliveries
        where account_id=$1 and ($2::text is null or binding_id=$2) and ($3::timestamptz is null or (created_at, id) < ($3::timestamptz, $4::text))
        order by created_at desc, id desc limit $5`,
      [auth.accountId, q.bindingId ?? null, after?.[0] ?? null, after?.[1] ?? "", q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json(DeliveryList.parse({
      items: page.map((r) => ({ id: r.id, bindingId: r.binding_id, channel: r.channel, eventKind: r.event_kind, status: r.status, attempts: r.attempts, errorCode: r.error_code, createdAt: r.created_at.toISOString(), sentAt: r.sent_at?.toISOString() ?? null })),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null,
    }));
  });

  return app;
}
