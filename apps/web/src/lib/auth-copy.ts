import { describeFailure, type ApiFailure } from "./api";

/** "about 1 minute", "45 seconds": the Retry-After header is the only source; never a guess. */
export function formatRetry(seconds: number | null): string {
  if (seconds === null) return "a little while";
  if (seconds < 90) return `${Math.ceil(seconds)} second${Math.ceil(seconds) === 1 ? "" : "s"}`;
  const m = Math.ceil(seconds / 60);
  return m < 90 ? `${m} minutes` : `${Math.ceil(m / 60)} hours`;
}

const http = (f: ApiFailure) => (f.kind === "http" ? f : null);
export const isCode = (f: ApiFailure, code: string): boolean => http(f)?.code === code;
export const isStatus = (f: ApiFailure, status: number): boolean => http(f)?.status === status;
export const isStepUpRequired = (f: ApiFailure): boolean => isCode(f, "STEP_UP_REQUIRED");
export const isVersionConflict = (f: ApiFailure): boolean => isCode(f, "VERSION_CONFLICT");

export interface Copy {
  title: string;
  body: string;
  tone: "danger" | "warning" | "info";
}

const rate = (f: ApiFailure): Copy => ({
  title: "Too many attempts",
  body: `Wait ${formatRetry(http(f)?.retryAfterSeconds ?? null)} and try again. Waiting is required even if the details are correct.`,
  tone: "warning",
});

/** One generic message for every credential failure: it never says whether the username exists. */
export function passwordSignInCopy(f: ApiFailure): Copy {
  if (isStatus(f, 429)) return rate(f);
  if (isStatus(f, 401)) return { title: "Sign-in failed", body: "The username or password is incorrect.", tone: "danger" };
  return { title: "Could not sign in", body: describeFailure(f), tone: "danger" };
}

export function signupCopy(f: ApiFailure): Copy {
  if (isStatus(f, 429)) return rate(f);
  if (isStatus(f, 409)) return { title: "Username unavailable", body: "Choose a different username.", tone: "danger" };
  if (isStatus(f, 422)) return { title: "Check the details", body: "The username or password was not accepted. Use 3 to 64 characters for the username and at least 12 for the password.", tone: "danger" };
  return { title: "Could not create the account", body: describeFailure(f), tone: "danger" };
}

export function recoveryCopy(f: ApiFailure): Copy {
  if (isStatus(f, 429)) return rate(f);
  if (isStatus(f, 401)) return { title: "Recovery failed", body: "The username or recovery code is not valid. Codes work once and expire.", tone: "danger" };
  if (isStatus(f, 422)) return { title: "Check the new password", body: "Use at least 12 characters.", tone: "danger" };
  return { title: "Could not recover", body: describeFailure(f), tone: "danger" };
}

/** 503 = the server has no Telegram bot. That is a configuration state, not a failure of the user's input. */
export function telegramCopy(f: ApiFailure): Copy {
  if (isStepUpRequired(f)) return { title: "Verify it is you first", body: "Linking needs a recent sign-in. Verify in the box below, then get a code again.", tone: "warning" };
  if (isStatus(f, 503)) return { title: "Telegram is not configured", body: "This deployment has no Telegram bot, so Telegram sign-in is unavailable. Use another method.", tone: "info" };
  if (isStatus(f, 429)) return rate(f);
  if (isStatus(f, 401) || isCode(f, "CHALLENGE_INVALID")) return { title: "Code not verified", body: "The code has not been sent to the bot yet, is wrong, or has expired. Send it from Telegram and try again, or get a new code.", tone: "warning" };
  return { title: "Telegram sign-in failed", body: describeFailure(f), tone: "danger" };
}

export function keySessionCopy(f: ApiFailure): Copy {
  if (isStatus(f, 429)) return rate(f);
  if (isStatus(f, 401)) return { title: "Key not accepted", body: "The key is unknown, revoked, expired, or does not have the usage:read permission.", tone: "danger" };
  if (isStatus(f, 403)) return { title: "Key cannot open the console", body: "This key needs the usage:read permission.", tone: "danger" };
  return { title: "Could not sign in with the key", body: describeFailure(f), tone: "danger" };
}

/** Step-up verification failures are a generic 403 on purpose. */
export function stepUpCopy(f: ApiFailure): Copy {
  if (isStatus(f, 429)) return rate(f);
  if (isStatus(f, 403)) return { title: "Not verified", body: "That did not verify. Check it and try again.", tone: "danger" };
  if (isStatus(f, 503)) return telegramCopy(f);
  return { title: "Could not verify", body: describeFailure(f), tone: "danger" };
}

export function removeMethodCopy(f: ApiFailure, what: string): Copy {
  if (isCode(f, "LAST_AUTH_METHOD")) return { title: "Not removed", body: `${what} is your only sign-in method, so it cannot be removed. Add another method first.`, tone: "warning" };
  if (isCode(f, "NOT_FOUND")) return { title: "Already removed", body: `${what} was already gone. The list was refreshed.`, tone: "info" };
  if (isStepUpRequired(f)) return { title: "Verify it is you", body: "Removing a sign-in method needs a recent sign-in. Verify below, then try again.", tone: "warning" };
  return { title: "Not removed", body: describeFailure(f), tone: "danger" };
}

/** Common copy for role/restriction refusals; `what` is a noun phrase such as "optimization policy". */
export function forbiddenCopy(f: ApiFailure, what: string): string | null {
  return isStatus(f, 403) && !isStepUpRequired(f) ? `Your role or session cannot change the ${what}. Ask an owner or admin, or sign in with a full session.` : null;
}
