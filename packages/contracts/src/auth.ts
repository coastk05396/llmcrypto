import { z } from "zod";
import { Id, Timestamp } from "./common";

export const WalletProtocol = z.enum(["evm", "tron"]);
export const MembershipRole = z.enum(["owner", "admin", "billing", "member"]);

export const WalletChallengeRequest = z.object({
  protocol: WalletProtocol,
  address: z.string().min(1).max(128),
  /** Opaque chain identifier (EVM decimal chain id, TRON network name); policy-checked server side. */
  chainId: z.string().min(1).max(64),
  /** "login" (default) creates/opens a session; "link" requires a current session and binds a new identity to it. */
  purpose: z.enum(["login", "link"]).optional(),
});

export const WalletChallenge = z.object({
  challengeId: Id,
  /** Server-authored message to sign verbatim (ERC-4361 for EVM; domain-bound canonical text for TRON). */
  message: z.string().min(1),
  expiresAt: Timestamp,
});

export const WalletSessionRequest = z.object({
  challengeId: Id,
  signature: z.string().min(1).max(2048),
});

/** Wallet identity bound to a user. Never exposes anything but the canonical address and policy. */
export const LinkedIdentity = z.object({
  id: Id,
  protocol: WalletProtocol,
  address: z.string().min(1),
  /** eip155 for EVM (chain-agnostic EOA); "tron:<network>" for TRON. */
  chainPolicy: z.string().min(1),
  createdAt: Timestamp,
});
export const IdentityList = z.object({ items: z.array(LinkedIdentity) });

export const User = z.object({ id: Id, createdAt: Timestamp });
export const Account = z.object({ id: Id, name: z.string().nullable() });
export const Membership = z.object({ id: Id, accountId: Id, userId: Id, role: MembershipRole });

/** How the session was established. `api_key` sessions are restricted: they never exceed the key's own data scope. */
export const SessionKind = z.enum(["wallet", "password", "telegram", "api_key"]);

/** Body of every sign-in endpoint (200), GET /api/session and POST /api/session/renew. */
export const SessionView = z.object({
  user: User,
  account: Account,
  membership: Membership,
  expiresAt: Timestamp,
  /** Absent in older payloads = "wallet". */
  sessionKind: SessionKind.default("wallet"),
  /** True for api_key sessions: no secrets, no identity/security changes, no privileged keys, data limited to the key. */
  restricted: z.boolean().default(false),
});

// ---------------------------------------------------------------- password + recovery codes

/** 3-64 chars; compared case-insensitively (stored lowercase). */
export const Username = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/, "3-64 characters: letters, digits, '.', '_' or '-'");
/** Length is the only composition rule (NIST SP 800-63B): 12-128 characters. */
export const NewPassword = z.string().min(12, "at least 12 characters").max(128, "at most 128 characters");

/** POST /api/auth/password/signup (new account) and POST /api/auth/password (link to the current session). */
export const PasswordSetupRequest = z.object({ username: Username, password: NewPassword });
/** POST /api/auth/password/sessions. Failures are always the same generic 401. */
export const PasswordSessionRequest = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(128) });
/** POST /api/auth/password/recovery: spends one recovery code, sets a new password, revokes every session. */
export const PasswordRecoveryRequest = z.object({
  username: z.string().min(1).max(64),
  recoveryCode: z.string().min(1).max(64),
  newPassword: NewPassword,
});
/** Plaintext codes are shown exactly once (signup/link/regenerate). Single use; all expire at `expiresAt`. */
export const RecoveryCodes = z.object({ recoveryCodes: z.array(z.string().min(1)).min(1), expiresAt: Timestamp });
export const PasswordSignupResponse = z.object({ session: SessionView, recovery: RecoveryCodes });

// ---------------------------------------------------------------- Telegram one-time code

export const TelegramCodePurpose = z.enum(["login", "link", "step_up"]);
/** POST /api/auth/telegram/codes. link/step_up need a current session. */
export const TelegramCodeRequest = z.object({ purpose: TelegramCodePurpose.default("login") });
/**
 * The user sends `code` to the Telegram bot; the server then verifies it through its TelegramBot port.
 * The code itself is shown once here and stored only as a digest.
 */
export const TelegramCode = z.object({ codeId: Id, code: z.string().min(1), purpose: TelegramCodePurpose, expiresAt: Timestamp });
/** POST /api/auth/telegram/sessions (login), /api/auth/telegram/identities (link) and /api/session/step-up. */
export const TelegramVerifyRequest = z.object({ codeId: Id });
export const TelegramIdentity = z.object({ id: Id, telegramUserId: z.string().min(1), createdAt: Timestamp });

// ---------------------------------------------------------------- API-key console session, step-up, methods

/** POST /api/auth/key-sessions. The key needs the usage:read scope. */
export const KeySessionRequest = z.object({ apiKey: z.string().min(1).max(256) });
/** POST /api/session/step-up for password sessions; Telegram sessions send { codeId } (TelegramVerifyRequest). */
export const StepUpRequest = z.union([z.object({ password: z.string().min(1).max(128) }), TelegramVerifyRequest]);

export const AuthMethods = z.object({
  wallets: z.array(LinkedIdentity),
  telegram: z.array(TelegramIdentity),
  password: z.object({ id: Id, username: z.string(), unusedRecoveryCodes: z.number().int().min(0) }).nullable(),
});

export type WalletProtocol = z.infer<typeof WalletProtocol>;
export type MembershipRole = z.infer<typeof MembershipRole>;
export type WalletChallengeRequest = z.infer<typeof WalletChallengeRequest>;
export type WalletChallenge = z.infer<typeof WalletChallenge>;
export type WalletSessionRequest = z.infer<typeof WalletSessionRequest>;
export type LinkedIdentity = z.infer<typeof LinkedIdentity>;
export type IdentityList = z.infer<typeof IdentityList>;
export type User = z.infer<typeof User>;
export type Account = z.infer<typeof Account>;
export type Membership = z.infer<typeof Membership>;
export type SessionView = z.infer<typeof SessionView>;
export type SessionKind = z.infer<typeof SessionKind>;
export type PasswordSetupRequest = z.infer<typeof PasswordSetupRequest>;
export type PasswordSessionRequest = z.infer<typeof PasswordSessionRequest>;
export type PasswordRecoveryRequest = z.infer<typeof PasswordRecoveryRequest>;
export type RecoveryCodes = z.infer<typeof RecoveryCodes>;
export type PasswordSignupResponse = z.infer<typeof PasswordSignupResponse>;
export type TelegramCodePurpose = z.infer<typeof TelegramCodePurpose>;
export type TelegramCodeRequest = z.infer<typeof TelegramCodeRequest>;
export type TelegramCode = z.infer<typeof TelegramCode>;
export type TelegramVerifyRequest = z.infer<typeof TelegramVerifyRequest>;
export type TelegramIdentity = z.infer<typeof TelegramIdentity>;
export type KeySessionRequest = z.infer<typeof KeySessionRequest>;
export type StepUpRequest = z.infer<typeof StepUpRequest>;
export type AuthMethods = z.infer<typeof AuthMethods>;
