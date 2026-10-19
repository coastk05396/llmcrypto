/// <reference lib="dom" />
import type { BrowserContext } from "@playwright/test";
import { tronMessageDigest } from "../../apps/api/src/auth/tron";
import { newEvm, type MockEvm, type MockTron } from "./wallet-mock";

export const WEB_ORIGIN = "http://127.0.0.1:4173";

interface Json { [k: string]: any } // eslint-disable-line @typescript-eslint/no-explicit-any -- untyped test JSON

async function post(path: string, body: unknown, cookie?: string): Promise<{ status: number; json: Json; setCookie: string[] }> {
  const res = await fetch(`${WEB_ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : {}, setCookie: res.headers.getSetCookie() };
}

async function signFor(w: MockEvm | MockTron, message: string): Promise<string> {
  return w.kind === "evm" ? w.account.signMessage({ message }) : w.account.sign({ hash: tronMessageDigest(message) });
}

/** Signs in through the real API (through the web origin's proxy) and returns the session cookie value. */
export async function apiSignIn(w: MockEvm | MockTron): Promise<{ session: string; accountId: string }> {
  const chainId = w.kind === "evm" ? "1" : "mainnet";
  const c = await post("/api/auth/wallet/challenges", { protocol: w.kind, address: w.address, chainId });
  if (c.status !== 201) throw new Error(`challenge failed: ${c.status} ${JSON.stringify(c.json)}`);
  // the challenge response sets a per-challenge `wc_<id>` binding cookie that session creation requires (pre-session binding)
  const binding = c.setCookie.map((x) => x.split(";")[0]!).filter((x) => x.startsWith("wc_")).join("; ");
  const s = await post("/api/auth/wallet/sessions", { challengeId: c.json["challengeId"], signature: await signFor(w, String(c.json["message"])) }, binding || undefined);
  if (s.status !== 200) throw new Error(`session failed: ${s.status} ${JSON.stringify(s.json)}`);
  const raw = s.setCookie.find((x) => x.startsWith("session="));
  if (!raw) throw new Error("no session cookie");
  return { session: raw.split(";")[0]!.slice("session=".length), accountId: String(s.json["account"]["id"]) };
}

export async function useSession(context: BrowserContext, session: string): Promise<void> {
  await context.addCookies([{ name: "session", value: session, url: WEB_ORIGIN }]);
}

/** Creates a key through the API so list/revoke views have data. Returns the one-time secret. */
export async function apiCreateKey(session: string, name: string, extra: Json = {}): Promise<{ secret: string; id: string }> {
  const res = await fetch(`${WEB_ORIGIN}/api/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN, Cookie: `session=${session}`, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ name, scopes: ["gateway:invoke"], modelAllowlist: [], ...extra }),
  });
  const j = (await res.json()) as Json;
  if (res.status !== 201 || j["secretStatus"] !== "PROVIDED") throw new Error(`key create failed ${res.status} ${JSON.stringify(j)}`);
  return { secret: String(j["secret"]), id: String(j["key"]["id"]) };
}

export async function gatewayModelsStatus(secret: string): Promise<{ status: number; count: number }> {
  const res = await fetch(`${WEB_ORIGIN}/v1/models`, { headers: { Authorization: `Bearer ${secret}` } });
  const j = (await res.json().catch(() => ({}))) as Json;
  return { status: res.status, count: Array.isArray(j["data"]) ? j["data"].length : 0 };
}

export const CONTROL = "http://127.0.0.1:3102";

async function control(path: string, body: Json): Promise<void> {
  const res = await fetch(`${CONTROL}${path}`, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`control ${path} failed: ${res.status} ${await res.text()}`);
}

/** TEST SETUP ONLY: funds an account through apps/api/src/dev/credit.ts (no HTTP credit route exists in the product). */
export const fundAccount = (accountId: string, amountMicrousd: string) => control("/credit", { accountId, amountMicrousd });
/** Sends a fake-chain transfer to a deposit address, mines `blocks`, and lets the real chain observer ingest it. */
export const chainPay = (p: { network: string; address: string; amountAtomic: string; assetContract: string; blocks: number }) => control("/chain/pay", p);
export const chainAdvance = (network: string, blocks: number) => control("/chain/advance", { network, blocks });

/** A real gateway call with the FakeProvider. Returns the HTTP status and parsed body. */
export async function chatCompletion(secret: string, content: string, headers: Record<string, string> = {}, model = "sample-fast-1"): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${WEB_ORIGIN}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}`, ...headers },
    body: JSON.stringify({ model, messages: [{ role: "user", content }], max_tokens: 50 }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : {} };
}

export async function apiGet(session: string, path: string): Promise<Json> {
  const res = await fetch(`${WEB_ORIGIN}${path}`, { headers: { Cookie: `session=${session}` } });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return (await res.json()) as Json;
}

export async function apiCreateDeposit(session: string, body: Json): Promise<Json> {
  const res = await fetch(`${WEB_ORIGIN}/api/deposits`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN, Cookie: `session=${session}`, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as Json;
  if (!res.ok) throw new Error(`deposit create failed ${res.status} ${JSON.stringify(j)}`);
  return j;
}

/** A fresh signed-in, funded account with one gateway key. Funding goes through the dev credit helper (test setup only). */
export async function fundedAccount(microusd = "5000000"): Promise<{ session: string; accountId: string; secret: string }> {
  const { session, accountId } = await apiSignIn(newEvm());
  await fundAccount(accountId, microusd);
  const { secret } = await apiCreateKey(session, "e2e-gateway-key");
  return { session, accountId, secret };
}

/** Plays the human sending `text` to the Telegram sign-in bot (fake bot; no real Telegram exists). */
export const telegramSend = (senderId: string, text: string) => control("/telegram/send", { senderId, text });
/** Plays the human sending `text` to the notification channel's bot (fake provider). */
export const channelSend = (senderId: string, text: string) => control("/channel/send", { channel: "telegram", senderId, text });
export const channelFailNext = () => control("/channel/fail-next", {});
export async function channelSent(): Promise<{ deliveryId: string; to: string; text: string }[]> {
  const res = await fetch(`${CONTROL}/channel/sent`);
  return (await res.json()) as { deliveryId: string; to: string; text: string }[];
}
/** Makes the account's sessions look signed in long ago (next privileged call answers 403 STEP_UP_REQUIRED). */
export const ageSessions = (accountId: string) => control("/sessions/age", { accountId });
export const shortenSessions = (accountId: string, seconds: number) => control("/sessions/shorten", { accountId, seconds });

/** Creates a password account through the real API; returns the one-time recovery codes and the session cookie value. */
export async function apiPasswordSignup(username: string, password: string): Promise<{ session: string; accountId: string; recoveryCodes: string[] }> {
  const res = await fetch(`${WEB_ORIGIN}/api/auth/password/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN },
    body: JSON.stringify({ username, password }),
  });
  const j = (await res.json()) as Json;
  if (res.status !== 201) throw new Error(`signup failed ${res.status} ${JSON.stringify(j)}`);
  const raw = res.headers.getSetCookie().find((x) => x.startsWith("session="));
  return { session: raw!.split(";")[0]!.slice("session=".length), accountId: String(j["session"]["account"]["id"]), recoveryCodes: j["recovery"]["recoveryCodes"] as string[] };
}

/** Generic JSON call with the session cookie (setup/oracle use only). */
export async function apiCall(session: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${WEB_ORIGIN}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN, Cookie: `session=${session}`, ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : {} };
}

/** Unique-per-call digits / names so parallel specs never collide on shared usernames or Telegram ids. */
let seq = 0;
export const uniqDigits = (): string => `${Date.now()}${process.pid % 1000}${seq++}`.slice(-14).padStart(9, "7");
export const uniqName = (p: string): string => `${p}${uniqDigits()}`.slice(0, 40);

/** Telegram login through the real API with the fake bot playing the human. Returns the session cookie value. */
export async function apiTelegramSignIn(senderId: string): Promise<{ session: string; accountId: string }> {
  const c = await post("/api/auth/telegram/codes", { purpose: "login" });
  if (c.status !== 201) throw new Error(`telegram code failed ${c.status} ${JSON.stringify(c.json)}`);
  await telegramSend(senderId, String(c.json["code"]));
  const s = await post("/api/auth/telegram/sessions", { codeId: c.json["codeId"] });
  if (s.status !== 200) throw new Error(`telegram session failed ${s.status} ${JSON.stringify(s.json)}`);
  const raw = s.setCookie.find((x) => x.startsWith("session="));
  return { session: raw!.split(";")[0]!.slice("session=".length), accountId: String(s.json["account"]["id"]) };
}
