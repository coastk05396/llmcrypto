/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers parse untyped JSON */
import { randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApp } from "../../apps/api/src/app";
import { loadConfig, type AppConfig } from "../../apps/api/src/config";
import { migrate, openPglite, type Db } from "../../apps/api/src/db";
import { createSession } from "../../apps/api/src/auth/session";
import { tronAddressFromBytes20, tronMessageDigest } from "../../apps/api/src/auth/tron";
import { randomId } from "../../apps/api/src/crypto";

export const ORIGIN = "https://app.example.test";
export const BASE_TIME = new Date("2026-10-18T12:00:00Z");

/** Secrets are generated per run; nothing here is a real credential. */
export const testSecrets = () => ({
  SESSION_SECRET: randomBytes(32).toString("hex"),
  API_KEY_HASH_PEPPER: randomBytes(32).toString("hex"),
  KEY_REPLAY_ENCRYPTION_SECRET: randomBytes(32).toString("hex"),
});

export interface Harness {
  db: Db;
  config: AppConfig;
  clock: { now: Date };
  secrets: ReturnType<typeof testSecrets>;
  app: ReturnType<typeof createApp>;
  /** Builds another app over the same database with config changes (e.g. different domain). */
  appWith(overrides: Partial<AppConfig>): ReturnType<typeof createApp>;
}

export async function makeHarness(overrides: Partial<AppConfig> = {}, env: Record<string, string | undefined> = {}): Promise<Harness> {
  const db = await openPglite();
  const secrets = testSecrets();
  const clock = { now: new Date(BASE_TIME) };
  const base = loadConfig(
    { ALLOW_TEST_COMPONENTS: "true", WEB_ORIGIN: ORIGIN, AUTH_EVM_CHAIN_IDS: "1,8453", AUTH_TRON_NETWORKS: "mainnet,nile", ...secrets, ...env },
    {
      now: () => new Date(clock.now),
      rateLimits: { challenge: { limit: 10_000, windowSeconds: 60 }, session: { limit: 10_000, windowSeconds: 60 }, keys: { limit: 10_000, windowSeconds: 60 } },
      ...overrides,
    },
  );
  await migrate(db, base.migrationsDir);
  return { db, config: base, clock, secrets, app: createApp({ db, config: base }), appWith: (o) => createApp({ db, config: { ...base, ...o } }) };
}

type App = Harness["app"];
export interface Call {
  body?: unknown;
  cookie?: string | undefined;
  origin?: string | null;
  headers?: Record<string, string>;
  rawBody?: string;
  /** Test the absence of the pre-session challenge cookie. */
  noChallengeCookies?: boolean;
}
export interface Res<T = unknown> {
  status: number;
  json: T;
  headers: Headers;
  setCookie: string[];
}

/** Browser stand-in for the per-challenge pre-session cookies (wc_<challengeId>): kept per app, sent with every request like a cookie jar. */
const challengeJar = new Map<string, string>();

export async function call<T = any>(app: App, method: string, path: string, c: Call = {}): Promise<Res<T>> {
  const headers: Record<string, string> = { ...(c.headers ?? {}) };
  const origin = c.origin === undefined ? ORIGIN : c.origin;
  if (origin) headers["Origin"] = origin;
  const jar = [...challengeJar].map(([k, v]) => `${k}=${v}`);
  const cookieHeader = [c.cookie, ...(c.noChallengeCookies ? [] : jar)].filter(Boolean).join("; ");
  if (cookieHeader) headers["Cookie"] = cookieHeader;
  let body: string | undefined;
  if (c.rawBody !== undefined) body = c.rawBody;
  else if (c.body !== undefined) body = JSON.stringify(c.body);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await app.request(path, { method, headers, ...(body !== undefined ? { body } : {}) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  for (const sc of res.headers.getSetCookie()) {
    const m = /^(wc_[^=]+)=([^;]*)/.exec(sc);
    if (m) {
      challengeJar.set(m[1]!, m[2]!);
    }
  }
  return { status: res.status, json: json as T, headers: res.headers, setCookie: res.headers.getSetCookie() };
}

export const cookieOf = (r: Res): string => {
  const sc = r.setCookie.find((c) => c.startsWith("session="));
  if (!sc) throw new Error("no session cookie");
  return sc.split(";")[0]!;
};

export interface EvmWallet {
  kind: "evm";
  account: PrivateKeyAccount;
  address: string;
  chainId: string;
}
export interface TronWallet {
  kind: "tron";
  account: PrivateKeyAccount;
  address: string;
  chainId: string;
}
export type Wallet = EvmWallet | TronWallet;

/** Test keys are generated at runtime and never persisted. */
export const newEvmWallet = (chainId = "1"): EvmWallet => {
  const account = privateKeyToAccount(generatePrivateKey());
  return { kind: "evm", account, address: account.address, chainId };
};
export const newTronWallet = (network = "mainnet"): TronWallet => {
  const account = privateKeyToAccount(generatePrivateKey());
  return { kind: "tron", account, address: tronAddressFromBytes20(Buffer.from(account.address.slice(2), "hex")), chainId: network };
};

export async function sign(w: Wallet, message: string): Promise<string> {
  return w.kind === "evm" ? w.account.signMessage({ message }) : w.account.sign({ hash: tronMessageDigest(message) });
}

export async function challenge(app: App, w: Wallet, opts: { cookie?: string; purpose?: "login" | "link" } = {}) {
  return call<any>(app, "POST", "/api/auth/wallet/challenges", {
    body: { protocol: w.kind, address: w.address, chainId: w.chainId, ...(opts.purpose ? { purpose: opts.purpose } : {}) },
    cookie: opts.cookie,
  });
}

export interface LoggedIn {
  cookie: string;
  view: any;
  userId: string;
  accountId: string;
  wallet: Wallet;
}

export async function login(app: App, w: Wallet = newEvmWallet()): Promise<LoggedIn> {
  const ch = await challenge(app, w);
  if (ch.status !== 201) throw new Error(`challenge failed ${ch.status} ${JSON.stringify(ch.json)}`);
  const signature = await sign(w, ch.json.message);
  const s = await call(app, "POST", "/api/auth/wallet/sessions", { body: { challengeId: ch.json.challengeId, signature } });
  if (s.status !== 200) throw new Error(`login failed ${s.status} ${JSON.stringify(s.json)}`);
  return { cookie: cookieOf(s), view: s.json, userId: s.json.user.id, accountId: s.json.account.id, wallet: w };
}

/** Adds a user with the given role to an existing account and returns their session cookie. */
export async function seedMember(h: Harness, accountId: string, role: "owner" | "admin" | "billing" | "member"): Promise<{ cookie: string; userId: string }> {
  const userId = randomId("usr");
  await h.db.query("insert into users (id, created_at) values ($1,$2)", [userId, h.clock.now]);
  await h.db.query("insert into memberships (id, account_id, user_id, role, created_at) values ($1,$2,$3,$4,$5)", [randomId("mem"), accountId, userId, role, h.clock.now]);
  const s = await h.db.tx((q) => createSession(q, h.config, userId, accountId));
  return { cookie: `session=${s.token}`, userId };
}

/** All text-ish content of every public table, for plaintext-absence assertions. */
export async function dumpDatabase(db: Db): Promise<string> {
  const tables = await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'");
  const parts: string[] = [];
  for (const t of tables) {
    const rows = await db.query(`select to_jsonb(t) as r from ${t.table_name} t`);
    parts.push(JSON.stringify(rows));
  }
  return parts.join("\n");
}

export const advance = (h: Harness, seconds: number): void => {
  h.clock.now = new Date(h.clock.now.getTime() + seconds * 1000);
};
