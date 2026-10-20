import {
  AuthMethods, PasswordSignupResponse, RecoveryCodes, SessionView, TelegramCode, TelegramIdentity,
  type KeySessionRequest, type PasswordRecoveryRequest, type PasswordSessionRequest, type PasswordSetupRequest, type TelegramCodePurpose,
} from "@llmcrypto/contracts";
import { call, callNoContent } from "./api";

/** Alternative sign-in methods (task 16). Bodies and statuses follow packages/contracts/openapi.yaml. */
export const passwordSignup = (body: PasswordSetupRequest, signal?: AbortSignal) =>
  call("POST", "/api/auth/password/signup", PasswordSignupResponse, { body, signal, status: 201 });
export const passwordSignIn = (body: PasswordSessionRequest, signal?: AbortSignal) =>
  call("POST", "/api/auth/password/sessions", SessionView, { body, signal, status: 200 });
export const passwordRecover = (body: PasswordRecoveryRequest, signal?: AbortSignal) =>
  callNoContent("POST", "/api/auth/password/recovery", signal, body);
export const addPassword = (body: PasswordSetupRequest, signal?: AbortSignal) =>
  call("POST", "/api/auth/password", RecoveryCodes, { body, signal, status: 201 });
export const removePassword = () => callNoContent("DELETE", "/api/auth/password");
export const regenerateRecoveryCodes = (signal?: AbortSignal) =>
  call("POST", "/api/auth/recovery-codes", RecoveryCodes, { signal, status: 201 });

export const issueTelegramCode = (purpose: TelegramCodePurpose, signal?: AbortSignal) =>
  call("POST", "/api/auth/telegram/codes", TelegramCode, { body: { purpose }, signal, status: 201 });
export const telegramSignIn = (codeId: string, signal?: AbortSignal) =>
  call("POST", "/api/auth/telegram/sessions", SessionView, { body: { codeId }, signal, status: 200 });
export const linkTelegram = (codeId: string, signal?: AbortSignal) =>
  call("POST", "/api/auth/telegram/identities", TelegramIdentity, { body: { codeId }, signal, status: 201 });
export const unlinkTelegram = (id: string) => callNoContent("DELETE", `/api/auth/telegram/identities/${encodeURIComponent(id)}`);

export const keySignIn = (body: KeySessionRequest, signal?: AbortSignal) =>
  call("POST", "/api/auth/key-sessions", SessionView, { body, signal, status: 200 });
export const listAuthMethods = (signal?: AbortSignal) => call("GET", "/api/auth/methods", AuthMethods, { signal });

export const renewSession = (signal?: AbortSignal) => call("POST", "/api/session/renew", SessionView, { signal, status: 200 });
/** 204 on success. A failed verification is 403 FORBIDDEN (deliberately generic); 429 carries Retry-After. */
export const stepUp = (body: { password: string } | { codeId: string }, signal?: AbortSignal) =>
  callNoContent("POST", "/api/session/step-up", signal, body);
