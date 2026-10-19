import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Binding, NotificationChannel, NotificationEventKind, PairingCode } from "@llmcrypto/contracts";
import { CopyBanner, LoadError, Skeleton, StatusLine } from "../components/Feedback";
import { CopyButton } from "../components/CopyButton";
import { Modal } from "../components/Modal";
import { Badge } from "../components/StatusBadge";
import { StepUpPanel } from "../components/StepUpPanel";
import { describeFailure, type ApiFailure } from "../lib/api";
import { confirmPairing, listBindings, listChannels, listDeliveries, sendTestMessage, startPairing, unpairBinding, updateBinding } from "../lib/api-product";
import { forbiddenCopy, formatRetry, isStatus, isStepUpRequired } from "../lib/auth-copy";
import { CHANNEL_LABEL, DELIVERY_STATUS, EVENT_KINDS, EVENT_LABEL, bindingLabel, modeLabel, sameEvents } from "../lib/connectivity";
import { formatUtc } from "../lib/format";
import { useSession } from "../lib/session";
import { useLoad } from "../lib/use-load";
import { usePaged } from "../lib/use-paged";

/** contracts exports the ChannelStatus schema but not its inferred type. */
interface ChannelStatus { channel: NotificationChannel; available: boolean; mode: "fake" | "live" | "unconfigured"; note: string }

const failText = (f: ApiFailure, what: string) => forbiddenCopy(f, what) ?? describeFailure(f);

function EventPicker({ legend, value, onChange }: { legend: string; value: NotificationEventKind[]; onChange(v: NotificationEventKind[]): void }) {
  return (
    <fieldset className="field fieldset">
      <legend>{legend}</legend>
      {EVENT_KINDS.map((k) => (
        <label key={k} className="check">
          <input type="checkbox" checked={value.includes(k)} onChange={(e) => onChange(e.target.checked ? [...value, k] : value.filter((x) => x !== k))} />
          <span>{EVENT_LABEL[k]}</span>
        </label>
      ))}
    </fieldset>
  );
}

// ---------------------------------------------------------------- pairing

type Pairing = { channel: NotificationChannel; code: PairingCode };

function PairingPanel({ pairing, onCancel, onPaired }: { pairing: Pairing; onCancel(): void; onPaired(b: Binding): void }) {
  const { handleFailure } = useSession();
  const [events, setEvents] = useState<NotificationEventKind[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "warning" | "danger"; title: string; body: string } | null>(null);
  const label = CHANNEL_LABEL[pairing.channel];

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    const r = await confirmPairing(pairing.code.pairingId, events);
    setBusy(false);
    if (r.ok) return onPaired(r.data);
    if (handleFailure(r.error)) return;
    if (isStatus(r.error, 422)) {
      const why = r.error.kind === "http" ? r.error.fieldErrors.find((f) => f.field === "pairing")?.message : undefined;
      return setMsg({ tone: "warning", title: "Not paired yet", body: `${why ?? "The code was not received."} Send the code from your ${label} account to the ${label} bot or number, wait a moment, then confirm again. The code is not used up until the pairing succeeds.` });
    }
    if (isStatus(r.error, 503)) return setMsg({ tone: "danger", title: `${label} is not configured`, body: "This deployment has no credentials for this channel, so it cannot be paired." });
    if (isStatus(r.error, 404)) return setMsg({ tone: "danger", title: "Pairing not found", body: "It expired or belongs to someone else. Start again." });
    setMsg({ tone: "danger", title: "Could not confirm", body: failText(r.error, "pairing") });
  }

  return (
    <section className="control" aria-labelledby="pair-head" data-testid="pairing-panel">
      <h3 id="pair-head" className="control__title">Pair {label}</h3>
      <p>Send this code to the {label} bot or number from the {label} account you want alerts on. Then press <strong>Confirm pairing</strong>.</p>
      <p>
        <span className="big-code" data-testid="pairing-code">{pairing.code.code}</span>{" "}
        <CopyButton text={pairing.code.code} what={`${label} pairing code`} />
      </p>
      <p className="small muted">Expires {new Date(pairing.code.expiresAt).toLocaleTimeString(undefined, { timeStyle: "short" })}. This code is shown only here and only once. Whoever sends it first claims it, so keep it private; you can unpair at any time.</p>
      <EventPicker legend="Alert me about (none selected means none until you choose)" value={events} onChange={setEvents} />
      {msg && <CopyBanner copy={msg} />}
      <div className="actions">
        <button type="button" className="btn btn--primary" aria-disabled={busy} onClick={() => void confirm()}>{busy ? "Confirming" : "Confirm pairing"}</button>
        <button type="button" className="btn btn--secondary" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}

function ChannelCard({ ch, onStart }: { ch: ChannelStatus; onStart(c: NotificationChannel): Promise<void> }) {
  const m = modeLabel(ch.mode);
  const [busy, setBusy] = useState(false);
  const label = CHANNEL_LABEL[ch.channel];
  return (
    <li className="key-row" data-testid={`channel-${ch.channel}`}>
      <div className="key-row__main">
        <h3 className="key-row__name">{label}</h3>
        <Badge tone={m.tone}>{m.label}</Badge>
      </div>
      <p className="muted">{ch.mode === "fake" ? "Test double: messages are recorded in the server process and nothing is really delivered to a chat." : ch.mode === "unconfigured" ? "Not configured: no credentials exist for this channel, so it cannot be paired." : "Live provider."}</p>
      <p className="small muted">{ch.note}</p>
      <div className="key-row__actions">
        <button type="button" className="btn btn--secondary btn--small" aria-disabled={!ch.available || busy}
          aria-describedby={!ch.available ? `na-${ch.channel}` : undefined}
          onClick={() => { if (ch.available && !busy) { setBusy(true); void onStart(ch.channel).finally(() => setBusy(false)); } }}>
          {busy ? "Starting" : `Pair ${label}`}
        </button>
        {!ch.available && <span id={`na-${ch.channel}`} className="small muted">Unavailable: not configured.</span>}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- bindings

function BindingRow({ b, onChanged, onUnpair, onTested }: { b: Binding; onChanged(msg: string): void; onUnpair(b: Binding): void; onTested(): void }) {
  const { handleFailure } = useSession();
  const [events, setEvents] = useState<NotificationEventKind[]>(b.events);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [msg, setMsg] = useState<{ tone: "info" | "warning" | "danger"; title: string; body: string } | null>(null);
  useEffect(() => setEvents(b.events), [b.events]);
  const dirty = !sameEvents(events, b.events);

  async function save() {
    if (busy || !dirty) return;
    setBusy("save");
    setMsg(null);
    const r = await updateBinding(b.id, events);
    setBusy(null);
    if (r.ok) return onChanged(`Alert preferences saved for ${bindingLabel(b)}`);
    if (handleFailure(r.error)) return;
    setMsg({ tone: "danger", title: "Not saved", body: failText(r.error, "alert preferences") });
  }
  async function test() {
    if (busy) return;
    setBusy("test");
    setMsg(null);
    const r = await sendTestMessage(b.id);
    setBusy(null);
    if (r.ok) { setMsg({ tone: "info", title: "Test message queued", body: "Delivery is asynchronous. Watch the delivery list below for its status." }); return onTested(); }
    if (handleFailure(r.error)) return;
    if (isStatus(r.error, 429)) return setMsg({ tone: "warning", title: "Wait a moment", body: `One test message per minute. Try again in ${formatRetry(r.error.kind === "http" ? r.error.retryAfterSeconds : null)}.` });
    setMsg({ tone: "danger", title: "Test not queued", body: failText(r.error, "binding") });
  }

  return (
    <li className="key-row" data-testid="binding">
      <div className="key-row__main"><h3 className="key-row__name">{CHANNEL_LABEL[b.channel]} <code>{b.destination}</code></h3></div>
      <EventPicker legend={`Alerts for ${bindingLabel(b)}`} value={events} onChange={setEvents} />
      {msg && <CopyBanner copy={msg} />}
      <div className="key-row__actions">
        <button type="button" className="btn btn--primary btn--small" aria-disabled={!dirty || busy !== null} onClick={() => void save()}>{busy === "save" ? "Saving" : "Save alerts"}</button>
        <button type="button" className="btn btn--secondary btn--small" aria-disabled={busy !== null} onClick={() => void test()}>{busy === "test" ? "Queuing" : "Send test message"}</button>
        <button type="button" className="btn btn--secondary btn--small" aria-label={`Unpair ${bindingLabel(b)}`} onClick={() => onUnpair(b)}>Unpair</button>
      </div>
    </li>
  );
}

function UnpairDialog({ target, onClose, onDone }: { target: Binding | null; onClose(): void; onDone(b: Binding): void }) {
  const { handleFailure } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { setBusy(false); setError(null); }, [target]);
  async function confirm() {
    if (!target || busy) return;
    setBusy(true);
    const r = await unpairBinding(target.id);
    setBusy(false);
    if (r.ok || isStatus(r.error, 404)) return onDone(target);
    if (handleFailure(r.error)) return;
    setError(failText(r.error, "binding"));
  }
  return (
    <Modal open={target !== null} title="Unpair this destination?" onRequestClose={() => { if (!busy) onClose(); }} initialFocus={cancel}>
      {target && (
        <div className="form-stack">
          <p>Stop sending alerts to {bindingLabel(target)}. Messages still queued for it are skipped. You can pair it again later.</p>
          {error && <p className="banner banner--danger" role="alert"><span className="banner__title">Not unpaired</span><span>{error}</span></p>}
          <div className="actions">
            <button ref={cancel} type="button" className="btn btn--secondary" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn--danger" aria-disabled={busy} onClick={() => void confirm()}>{busy ? "Unpairing" : "Unpair"}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- deliveries

function Deliveries({ refreshKey }: { refreshKey: number }) {
  const fetchPage = useCallback((cursor: string | null, signal: AbortSignal) => {
    void refreshKey;
    const q = new URLSearchParams({ limit: "50" });
    if (cursor) q.set("cursor", cursor);
    return listDeliveries(q.toString(), signal);
  }, [refreshKey]);
  const d = usePaged(fetchPage);
  const uid = useId();
  return (
    <section aria-labelledby={`${uid}-h`} className="section--ruled">
      <div className="page-head">
        <h2 id={`${uid}-h`} className="section-title">Deliveries</h2>
        <button type="button" className="btn btn--secondary btn--small" onClick={d.reload}>Refresh</button>
      </div>
      <p className="muted">Messages are queued and sent by a background job. Each row is one message to one destination. Message text is a fixed template plus an opaque reference: never keys, prompts, notes, amounts or addresses.</p>
      {d.state.status === "loading" && <Skeleton label="Loading deliveries" />}
      {d.state.status === "error" && <LoadError what="deliveries" failure={d.state.failure} onRetry={d.reload} />}
      {d.state.status === "ready" && d.state.items.length === 0 && <div className="empty"><h3>No deliveries yet</h3><p className="muted">Send a test message or wait for an alert you opted into.</p></div>}
      {d.state.status === "ready" && d.state.items.length > 0 && (
        <>
          <div className="table-wrap" role="region" aria-label="Deliveries table" tabIndex={0}>
            <table className="data-table" data-testid="deliveries-table">
              <caption className="sr-only">Notification deliveries, newest first</caption>
              <thead><tr><th scope="col">Queued (UTC)</th><th scope="col">Channel</th><th scope="col">Event</th><th scope="col">Status</th><th scope="col" className="num">Attempts</th><th scope="col">Error</th><th scope="col">Sent (UTC)</th></tr></thead>
              <tbody>
                {d.state.items.map((x) => {
                  const s = DELIVERY_STATUS[x.status];
                  return (
                    <tr key={x.id}>
                      <th scope="row"><time dateTime={x.createdAt}>{formatUtc(x.createdAt)}</time></th>
                      <td>{CHANNEL_LABEL[x.channel]}</td>
                      <td>{EVENT_LABEL[x.eventKind]}</td>
                      <td><Badge tone={s.tone}>{s.label}</Badge></td>
                      <td className="num">{x.attempts}</td>
                      <td>{x.errorCode ? <code>{x.errorCode}</code> : ""}</td>
                      <td>{x.sentAt ? formatUtc(x.sentAt) : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {d.state.nextCursor && <button type="button" className="btn btn--secondary" aria-disabled={d.state.loadingMore} onClick={d.loadMore}>{d.state.loadingMore ? "Loading" : "Load more"}</button>}
        </>
      )}
    </section>
  );
}

export function Connectivity() {
  const { handleFailure } = useSession();
  const [channels, reloadChannels] = useLoad(listChannels);
  const [bindings, reloadBindings] = useLoad(listBindings);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [startError, setStartError] = useState<{ title: string; body: string; tone: "danger" | "warning" | "info"; stepUp: boolean } | null>(null);
  const [unpairing, setUnpairing] = useState<Binding | null>(null);
  const [notice, setNotice] = useState("");
  const [deliveriesKey, setDeliveriesKey] = useState(0);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  async function start(channel: NotificationChannel) {
    setStartError(null);
    const r = await startPairing(channel);
    if (r.ok) { setPairing({ channel, code: r.data }); return; }
    if (handleFailure(r.error)) return;
    if (isStatus(r.error, 503)) return setStartError({ tone: "info", title: `${CHANNEL_LABEL[channel]} is not configured`, body: "This deployment has no credentials for this channel, so it cannot be paired.", stepUp: false });
    if (isStepUpRequired(r.error)) return setStartError({ tone: "warning", title: "Verify it is you first", body: "Pairing needs a recent sign-in. Verify below, then press Pair again.", stepUp: true });
    if (isStatus(r.error, 429)) return setStartError({ tone: "warning", title: "Too many open pairing codes", body: `Use or wait out an open code. Try again in ${formatRetry(r.error.kind === "http" ? r.error.retryAfterSeconds : null)}.`, stepUp: false });
    setStartError({ tone: "danger", title: "Could not start pairing", body: failText(r.error, "pairing (owners and admins pair channels)"), stepUp: false });
  }

  function refreshDeliveriesSoon() {
    // The worker delivers asynchronously; look a few times instead of pretending it is instant.
    for (const ms of [1500, 4000, 8000]) timers.current.push(window.setTimeout(() => setDeliveriesKey((k) => k + 1), ms));
  }

  return (
    <div className="page-body console-page">
      <p className="eyebrow">Console</p>
      <h1 className="page-title">Connectivity</h1>
      <p className="muted lead">Alerts to Telegram or WhatsApp. Pairing proves you control the destination, alerts are opt-in per event, and messages carry no secrets. Where a channel is a test double or not configured, this page says so; nothing is delivered to a real chat in that case.</p>

      <StatusLine>{notice}</StatusLine>

      <section aria-labelledby="ch-head">
        <h2 id="ch-head" className="section-title">Channels</h2>
        {channels.status === "loading" && <Skeleton label="Loading channels" />}
        {channels.status === "error" && <LoadError what="channels" failure={channels.failure} onRetry={reloadChannels} />}
        {channels.status === "ready" && (
          <ul className="key-list" aria-label="Channels">
            {channels.data.items.map((c) => <ChannelCard key={c.channel} ch={c} onStart={start} />)}
          </ul>
        )}
        {startError && (
          <CopyBanner copy={startError}>{startError.stepUp && <StepUpPanel onDone={() => setStartError(null)} />}</CopyBanner>
        )}
        {pairing && <PairingPanel pairing={pairing} onCancel={() => setPairing(null)} onPaired={(b) => { setPairing(null); setNotice(`Paired ${bindingLabel(b)}`); reloadBindings(); }} />}
      </section>

      <section aria-labelledby="bind-head" className="section--ruled">
        <h2 id="bind-head" className="section-title">Paired destinations</h2>
        {bindings.status === "loading" && <Skeleton label="Loading destinations" />}
        {bindings.status === "error" && <LoadError what="destinations" failure={bindings.failure} onRetry={reloadBindings} />}
        {bindings.status === "ready" && bindings.data.items.length === 0 && <div className="empty"><h3>Nothing paired</h3><p className="muted">Pair a channel above to receive alerts. No alerts are sent until you choose events.</p></div>}
        {bindings.status === "ready" && bindings.data.items.length > 0 && (
          <ul className="key-list" aria-label="Paired destinations">
            {bindings.data.items.map((b) => (
              <BindingRow key={b.id} b={b} onChanged={(m) => { setNotice(m); reloadBindings(); }} onUnpair={setUnpairing} onTested={refreshDeliveriesSoon} />
            ))}
          </ul>
        )}
      </section>

      <Deliveries refreshKey={deliveriesKey} />
      <UnpairDialog target={unpairing} onClose={() => setUnpairing(null)} onDone={(b) => { setUnpairing(null); setNotice(`Unpaired ${bindingLabel(b)}`); reloadBindings(); setDeliveriesKey((k) => k + 1); }} />
    </div>
  );
}
