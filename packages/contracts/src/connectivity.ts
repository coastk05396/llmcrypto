import { z } from "zod";
import { Id, PageQuery, Timestamp, listEnvelope } from "./common";

export const NotificationChannel = z.enum(["telegram", "whatsapp"]);
/** Events a binding can subscribe to. "test" exists but is only sent by the explicit test endpoint. */
export const NotificationEventKind = z.enum(["insufficient_funds", "key_cap_reached", "loop_guard", "deposit_credited", "deposit_needs_review"]);
export const DeliveryStatus = z.enum(["pending", "sent", "failed", "skipped"]);

export const ChannelStatus = z.object({
  channel: NotificationChannel,
  /** true only when a provider is wired in this process. */
  available: z.boolean(),
  /** "fake" = in-process test double, nothing is really delivered. "unconfigured" = pairing answers 503. */
  mode: z.enum(["fake", "live", "unconfigured"]),
  note: z.string(),
});
export const ChannelStatusList = z.object({ items: z.array(ChannelStatus) });

export const CreatePairingRequest = z.strictObject({ channel: NotificationChannel });
export const PairingCode = z.object({
  pairingId: Id,
  channel: NotificationChannel,
  /** Shown once. Send it to the account's bot/number, then call confirm. */
  code: z.string().min(1),
  expiresAt: Timestamp,
});
export const ConfirmPairingRequest = z.strictObject({ events: z.array(NotificationEventKind).max(5).optional() });

export const Binding = z.object({
  id: Id,
  channel: NotificationChannel,
  /** Masked: only the last four characters are shown. */
  destination: z.string(),
  events: z.array(NotificationEventKind),
  createdAt: Timestamp,
});
export const BindingList = z.object({ items: z.array(Binding) });
export const UpdateBindingRequest = z.strictObject({ events: z.array(NotificationEventKind).max(5) });

export const TestNotificationAccepted = z.object({ eventId: Id, bindingId: Id });

export const Delivery = z.object({
  id: Id,
  bindingId: Id,
  channel: NotificationChannel,
  eventKind: z.enum(["insufficient_funds", "key_cap_reached", "loop_guard", "deposit_credited", "deposit_needs_review", "test"]),
  status: DeliveryStatus,
  attempts: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  createdAt: Timestamp,
  sentAt: Timestamp.nullable(),
});
export const DeliveryList = listEnvelope(Delivery);
export const DeliveryQuery = PageQuery.extend({ bindingId: Id.optional() });

export type NotificationChannel = z.infer<typeof NotificationChannel>;
export type NotificationEventKind = z.infer<typeof NotificationEventKind>;
export type Binding = z.infer<typeof Binding>;
export type Delivery = z.infer<typeof Delivery>;
export type PairingCode = z.infer<typeof PairingCode>;
