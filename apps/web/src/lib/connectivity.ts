import type { Binding, Delivery, NotificationChannel, NotificationEventKind } from "@llmcrypto/contracts";
import type { BadgeTone } from "./tone";

export const CHANNEL_LABEL: Record<NotificationChannel, string> = { telegram: "Telegram", whatsapp: "WhatsApp" };

export const EVENT_LABEL: Record<NotificationEventKind | "test", string> = {
  insufficient_funds: "A request was refused for insufficient credit",
  key_cap_reached: "A request was refused because a key or project cap was reached",
  loop_guard: "LoopGuard noticed repeated identical requests",
  deposit_credited: "A deposit was credited",
  deposit_needs_review: "A deposit needs review",
  test: "Test message",
};
export const EVENT_KINDS = Object.keys(EVENT_LABEL).filter((k) => k !== "test") as NotificationEventKind[];

export const DELIVERY_STATUS: Record<Delivery["status"], { label: string; tone: BadgeTone; what: string }> = {
  pending: { label: "Pending", tone: "pending", what: "Queued or waiting to retry." },
  sent: { label: "Sent", tone: "success", what: "The channel accepted the message." },
  failed: { label: "Failed", tone: "danger", what: "Delivery failed and will not be retried." },
  skipped: { label: "Skipped", tone: "neutral", what: "Not sent, for example because the binding was removed." },
};

export type ChannelMode = "fake" | "live" | "unconfigured";
/** Labels never imply real delivery for a test double or an unconfigured channel. */
export function modeLabel(mode: ChannelMode): { label: string; tone: BadgeTone } {
  return mode === "fake" ? { label: "Test double", tone: "warning" } : mode === "unconfigured" ? { label: "Not configured", tone: "neutral" } : { label: "Live", tone: "success" };
}

export function sameEvents(a: readonly NotificationEventKind[], b: readonly NotificationEventKind[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

export const bindingLabel = (b: Pick<Binding, "channel" | "destination">) => `${CHANNEL_LABEL[b.channel]} ${b.destination}`;
