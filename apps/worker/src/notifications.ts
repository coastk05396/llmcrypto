/**
 * Alert delivery from the notification outbox (db/migrations/009).
 *
 * - Events are claimed with a conditional UPDATE and a lease, so two runners never process one event at once; a crashed
 *   runner's event is retried after the lease.
 * - Fan-out creates one delivery row per (event, binding) (unique), so a retry never duplicates a recipient. The delivery
 *   id is passed to the channel as an idempotency token; a provider that honours it makes a crash between "sent" and
 *   "recorded" harmless. Without that guarantee delivery is at-least-once.
 * - Only active bindings that subscribe to the kind receive it; a binding unpaired in the meantime is skipped.
 * - Message text is rendered by the domain from a fixed template + an opaque reference id: no keys, prompts, notes or amounts.
 * - Transient channel errors retry with exponential backoff (event.available_at) up to maxAttempts, then the delivery is
 *   `failed`; permanent errors fail at once. Failures never touch ledger or request state.
 * Real delivery is BLOCKED (no Telegram/WhatsApp credentials); runs against Fake providers only.
 */
import { ChannelError, renderNotification, type ChannelRegistry, type EventKind, type SqlDb, type SqlExecutor } from "@llmcrypto/domain";

export interface DeliveryRunnerOptions {
  db: SqlDb;
  channels: ChannelRegistry;
  now: () => Date;
  newId: (prefix: string) => string;
  leaseSeconds?: number;
  maxAttempts?: number;
  /** First retry delay; doubles per attempt. */
  backoffSeconds?: number;
  batch?: number;
}
export interface DeliveryReport {
  claimed: number;
  sent: number;
  failed: number;
  retrying: number;
  skipped: number;
}

interface EventRow {
  id: string;
  account_id: string;
  kind: EventKind;
  binding_id: string | null;
  data: { ref?: string };
}
interface DeliveryRow {
  id: string;
  binding_id: string;
  channel: "telegram" | "whatsapp";
  attempts: number;
}

async function claim(o: DeliveryRunnerOptions, at: Date): Promise<EventRow | null> {
  const lease = new Date(at.getTime() + (o.leaseSeconds ?? 120) * 1000);
  const rows = await o.db.query<EventRow>(
    `update notification_events set status='running', lease_until=$2
      where id = (select id from notification_events where available_at <= $1 and (status='queued' or (status='running' and lease_until <= $1)) order by available_at, id limit 1)
        and available_at <= $1 and (status='queued' or (status='running' and lease_until <= $1))
      returning id, account_id, kind, binding_id, data`,
    [at, lease],
  );
  return rows[0] ?? null;
}

/** One delivery row per active, subscribed binding (or just the targeted one for a test message). */
async function fanOut(q: SqlExecutor, o: DeliveryRunnerOptions, ev: EventRow, at: Date): Promise<void> {
  await q.query(
    `insert into notification_deliveries (id, event_id, binding_id, account_id, channel, event_kind, status, created_at, updated_at)
     select 'dlv_' || md5($1::text || b.id), $1::text, b.id, b.account_id, b.channel, $2::text, 'pending', $3::timestamptz, $3::timestamptz from notification_bindings b
      where b.account_id=$4 and b.unpaired_at is null
        and (($5::text is not null and b.id=$5) or ($5::text is null and b.events @> to_jsonb($2::text)))
     on conflict (event_id, binding_id) do nothing`,
    [ev.id, ev.kind, at, ev.account_id, ev.binding_id],
  );
}

export async function runNotificationDelivery(o: DeliveryRunnerOptions): Promise<DeliveryReport> {
  const report: DeliveryReport = { claimed: 0, sent: 0, failed: 0, retrying: 0, skipped: 0 };
  const max = o.maxAttempts ?? 3;
  for (let n = 0; n < (o.batch ?? 100); n++) {
    const ev = await claim(o, o.now());
    if (!ev) break;
    report.claimed++;
    await fanOut(o.db, o, ev, o.now());
    const pending = await o.db.query<DeliveryRow>("select id, binding_id, channel, attempts from notification_deliveries where event_id=$1 and status='pending' order by id", [ev.id]);
    let retryAt: Date | null = null;
    for (const d of pending) {
      const at = o.now();
      // Re-check at send time: an unpair after fan-out must stop the message.
      const [b] = await o.db.query<{ destination: string }>("select destination from notification_bindings where id=$1 and unpaired_at is null", [d.binding_id]);
      if (!b) {
        await o.db.query("update notification_deliveries set status='skipped', error_code='UNPAIRED', updated_at=$2 where id=$1 and status='pending'", [d.id, at]);
        report.skipped++;
        continue;
      }
      const provider = o.channels[d.channel];
      try {
        if (!provider) throw new ChannelError("transient", "CHANNEL_NOT_CONFIGURED", "no provider");
        const sent = await provider.send({ deliveryId: d.id, to: b.destination, text: renderNotification(ev.kind, ev.data.ref ?? null) });
        await o.db.query("update notification_deliveries set status='sent', attempts=attempts+1, provider_message_id=$2, error_code=null, sent_at=$3, updated_at=$3 where id=$1 and status='pending'", [d.id, sent.providerMessageId, at]);
        report.sent++;
      } catch (e) {
        const known = e instanceof ChannelError ? e : null;
        const code = known?.code ?? "SEND_FAILED";
        const attempts = d.attempts + 1;
        if (known?.kind === "permanent" || attempts >= max) {
          await o.db.query("update notification_deliveries set status='failed', attempts=$2, error_code=$3, updated_at=$4 where id=$1 and status='pending'", [d.id, attempts, code, at]);
          report.failed++;
        } else {
          await o.db.query("update notification_deliveries set attempts=$2, error_code=$3, updated_at=$4 where id=$1 and status='pending'", [d.id, attempts, code, at]);
          retryAt = new Date(at.getTime() + (o.backoffSeconds ?? 30) * 1000 * 2 ** (attempts - 1));
          report.retrying++;
        }
      }
    }
    if (retryAt) await o.db.query("update notification_events set status='queued', lease_until=null, available_at=$2 where id=$1", [ev.id, retryAt]);
    else await o.db.query("update notification_events set status='done', lease_until=null, processed_at=$2 where id=$1", [ev.id, o.now()]);
  }
  return report;
}
