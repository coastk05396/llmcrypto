/**
 * Notification events, minimal-data message rendering, and the channel port.
 *
 * Messages are built ONLY from a fixed template per event kind plus an opaque reference id. They never contain API
 * keys, prompts, notes, amounts or addresses. Real delivery is BLOCKED (no Telegram/WhatsApp credentials): only the
 * Fake providers below exist.
 */
import type { NotificationChannel, NotificationEventKind } from "@llmcrypto/contracts";
import type { SqlExecutor } from "./sql";

export type EventKind = NotificationEventKind | "test";
export const SUBSCRIBABLE_EVENTS: readonly NotificationEventKind[] = ["insufficient_funds", "key_cap_reached", "loop_guard", "deposit_credited", "deposit_needs_review"];

const TEMPLATE: Record<EventKind, string> = {
  insufficient_funds: "A request was refused because available credit was too low.",
  key_cap_reached: "A request was refused because a key or project spend cap was reached.",
  loop_guard: "LoopGuard noticed repeated identical requests.",
  deposit_credited: "A deposit was credited to your account.",
  deposit_needs_review: "A deposit needs review.",
  test: "This is a test message from your gateway console.",
};

const REF = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The complete message text. `ref` is an opaque request/deposit id and is dropped if it does not look like one. */
export function renderNotification(kind: EventKind, ref: string | null): string {
  const tail = ref !== null && REF.test(ref) ? ` Reference: ${ref}.` : "";
  return `LLM Gateway: ${TEMPLATE[kind]}${tail} Open the console for details.`;
}

export interface EnqueueInput {
  id: string;
  accountId: string;
  kind: EventKind;
  /** Aim a test message at one binding. */
  bindingId?: string | null;
  ref?: string | null;
  /** Unique per account; callers fold a time bucket in so alerts do not repeat every request. */
  dedupeKey: string;
  at: Date;
}

/**
 * Adds an outbox row in the caller's transaction. A non-test event is only written when some active binding of the
 * account subscribes to it (no subscriber = no row, nothing stored). Returns whether a row was created.
 */
export async function enqueueNotification(q: SqlExecutor, e: EnqueueInput): Promise<boolean> {
  const targeted = e.bindingId ?? null;
  const rows = await q.query<{ id: string }>(
    `insert into notification_events (id, account_id, kind, binding_id, data, dedupe_key, status, available_at, created_at)
     select $1::text,$2::text,$3::text,$4::text,$5::jsonb,$6::text,'queued',$7::timestamptz,$7::timestamptz
     where $4::text is not null or exists (
       select 1 from notification_bindings b where b.account_id=$2 and b.unpaired_at is null and b.events @> to_jsonb($3::text))
     on conflict (account_id, dedupe_key) do nothing returning id`,
    [e.id, e.accountId, e.kind, targeted, JSON.stringify(e.ref ? { ref: e.ref } : {}), e.dedupeKey, e.at],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------- channel port + fakes

export interface InboundMessage {
  /** Channel-side user identifier (Telegram numeric id, WhatsApp number digits). */
  senderId: string;
  text: string;
}
export interface OutboundMessage {
  /** Stable per delivery: a provider that honours it makes a retry after a crash harmless. */
  deliveryId: string;
  to: string;
  text: string;
}
export class ChannelError extends Error {
  constructor(readonly kind: "transient" | "permanent", readonly code: string, message: string) {
    super(message);
  }
}
export interface ChannelProvider {
  readonly channel: NotificationChannel;
  /** True for in-process test doubles. */
  readonly isFake: boolean;
  /** Messages received since the previous call (each is delivered once). */
  fetchInbound(): Promise<InboundMessage[]>;
  /** Returns the provider's message id. Throws ChannelError. */
  send(m: OutboundMessage): Promise<{ providerMessageId: string }>;
}
export type ChannelRegistry = Partial<Record<NotificationChannel, ChannelProvider>>;

/** Deterministic in-process stand-in for a Telegram bot or WhatsApp number. NOT a real channel. */
export class FakeChannelProvider implements ChannelProvider {
  readonly isFake = true;
  /** Everything "delivered", for assertions. Deduplicated by deliveryId like an idempotent provider. */
  readonly sent: (OutboundMessage & { providerMessageId: string })[] = [];
  private inbound: InboundMessage[] = [];
  private failures: ChannelError[] = [];
  constructor(readonly channel: NotificationChannel) {}
  /** Plays the human sending a message to the bot/number. */
  userSends(senderId: string, text: string): void {
    this.inbound.push({ senderId, text });
  }
  /** The next send() calls fail with these errors, in order. */
  failNext(...errors: ChannelError[]): void {
    this.failures.push(...errors);
  }
  async fetchInbound(): Promise<InboundMessage[]> {
    const out = this.inbound;
    this.inbound = [];
    return out;
  }
  async send(m: OutboundMessage): Promise<{ providerMessageId: string }> {
    const f = this.failures.shift();
    if (f) throw f;
    const prior = this.sent.find((s) => s.deliveryId === m.deliveryId);
    if (prior) return { providerMessageId: prior.providerMessageId };
    const providerMessageId = `fake-${this.channel}-${this.sent.length + 1}`;
    this.sent.push({ ...m, providerMessageId });
    return { providerMessageId };
  }
}
