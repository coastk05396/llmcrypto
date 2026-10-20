/// <reference lib="dom" />
import { describe, expect, it, vi } from "vitest";
import type { WalletChallenge } from "@llmcrypto/contracts";
import type { ApiFailure, ApiResult } from "../../apps/web/src/lib/api";
import {
  WalletFlowError, chainIdToDecimal, describeChallenge, failureToError, runWalletFlow, toHex, tronNetworkFromHost,
  type Eip1193Provider, type WalletApi, type WalletEnv, type WalletStage,
} from "../../apps/web/src/lib/wallet";

const SIWE = [
  "app.example.test wants you to sign in with your Ethereum account:",
  "0x00000000000000000000000000000000000000aa",
  "",
  "Sign in to LLM Gateway.",
  "",
  "URI: https://app.example.test",
  "Version: 1",
  "Chain ID: 1",
  "Nonce: abcdefgh12345678",
].join("\n");
const CHALLENGE: WalletChallenge = { challengeId: "chl_1", message: SIWE, expiresAt: "2026-10-18T12:05:00Z" };
const ADDR = "0x00000000000000000000000000000000000000aa";

const http = (code: string | null, status: number, extra: Partial<Extract<ApiFailure, { kind: "http" }>> = {}): ApiFailure => ({
  kind: "http", status, code, requestId: "req_1", fieldErrors: [], retryAfterSeconds: null, ...extra,
});

function fakeEvm(over: Partial<Record<string, (params?: unknown[]) => unknown>> = {}) {
  const handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  const calls: { method: string; params?: unknown[] | undefined }[] = [];
  const provider: Eip1193Provider = {
    async request({ method, params }) {
      calls.push({ method, params });
      const h = over[method];
      if (h) return h(params);
      if (method === "eth_requestAccounts") return [ADDR];
      if (method === "eth_chainId") return "0x1";
      if (method === "personal_sign") return "0xsig";
      throw new Error(`unexpected ${method}`);
    },
    on(ev, h) { (handlers.get(ev) ?? handlers.set(ev, new Set()).get(ev)!).add(h); },
    removeListener(ev, h) { handlers.get(ev)?.delete(h); },
  };
  const emit = (ev: string, ...a: unknown[]) => handlers.get(ev)?.forEach((h) => h(...a));
  return { provider, emit, calls, listenerCount: () => [...handlers.values()].reduce((n, s) => n + s.size, 0) };
}

const envOf = (over: Partial<WalletEnv>): WalletEnv => ({ evm: undefined, tronLink: undefined, tronWeb: undefined, onTronMessage: () => () => {}, ...over });

function fakeApi(opts: { challenge?: ApiResult<WalletChallenge>; complete?: ApiResult<string> } = {}) {
  const challenge = vi.fn(async () => opts.challenge ?? ({ ok: true, data: CHALLENGE } as const));
  const complete = vi.fn(async () => opts.complete ?? ({ ok: true, data: "SESSION" } as const));
  const api: WalletApi<string> = { challenge, complete };
  return { api, challenge, complete };
}

const run = (env: WalletEnv, api: WalletApi<string>, over: { protocol?: "evm" | "tron"; signal?: AbortSignal; stages?: WalletStage[] } = {}) =>
  runWalletFlow<string>({
    protocol: over.protocol ?? "evm", purpose: "login", env, api, signal: over.signal ?? new AbortController().signal,
    onStage: (s) => over.stages?.push(s),
  });

const codeOf = async (p: Promise<unknown>) => {
  try { await p; return "resolved"; } catch (e) { return e instanceof WalletFlowError ? e.code : `other:${String(e)}`; }
};

describe("EVM flow", () => {
  it("connects, asks the API for a challenge for the wallet address and decimal chain id, signs the exact message, then completes", async () => {
    const w = fakeEvm({ eth_chainId: () => "0x2105" });
    const { api, challenge, complete } = fakeApi();
    const stages: WalletStage[] = [];
    await expect(run(envOf({ evm: w.provider }), api, { stages })).resolves.toBe("SESSION");
    expect(challenge).toHaveBeenCalledWith({ protocol: "evm", address: ADDR, chainId: "8453", purpose: "login" }, expect.anything());
    const sign = w.calls.find((c) => c.method === "personal_sign")!;
    expect(sign.params).toEqual([toHex(SIWE), ADDR]);
    expect(complete).toHaveBeenCalledWith({ challengeId: "chl_1", signature: "0xsig" }, expect.anything());
    expect(stages.at(-1)).toEqual({ stage: "awaiting-signature", domain: "app.example.test", chain: "1", address: ADDR });
    expect(w.listenerCount()).toBe(0); // listeners removed after completion
  });

  it("reports no_wallet when there is no provider", async () => {
    expect(await codeOf(run(envOf({}), fakeApi().api))).toBe("no_wallet");
  });

  it("returns to a usable state when the user rejects the signature (EIP-1193 4001) and never calls the API to complete", async () => {
    const w = fakeEvm({ personal_sign: () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); } });
    const { api, complete } = fakeApi();
    expect(await codeOf(run(envOf({ evm: w.provider }), api))).toBe("rejected");
    expect(complete).not.toHaveBeenCalled();
    expect(w.listenerCount()).toBe(0);
  });

  it("treats a rejected connection request as rejected", async () => {
    const w = fakeEvm({ eth_requestAccounts: () => { throw Object.assign(new Error("denied"), { code: 4001 }); } });
    expect(await codeOf(run(envOf({ evm: w.provider }), fakeApi().api))).toBe("rejected");
  });

  it("discards the pending challenge when the account changes during signing: the signature is dropped unsent", async () => {
    let release!: (v: string) => void;
    const w = fakeEvm({ personal_sign: () => new Promise<string>((r) => { release = r; }) });
    const { api, complete } = fakeApi();
    const p = run(envOf({ evm: w.provider }), api);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    w.emit("accountsChanged", ["0x00000000000000000000000000000000000000bb"]);
    release("0xlate-signature");
    expect(await codeOf(p)).toBe("wallet_changed");
    expect(complete).not.toHaveBeenCalled();
  });

  it("discards the pending challenge when the chain changes before signing", async () => {
    const w = fakeEvm();
    const { api, complete } = fakeApi();
    api.challenge = vi.fn(async () => { w.emit("chainChanged", "0x89"); return { ok: true, data: CHALLENGE } as const; });
    expect(await codeOf(run(envOf({ evm: w.provider }), api))).toBe("wallet_changed");
    expect(w.calls.some((c) => c.method === "personal_sign")).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it("cancel via AbortSignal ends the flow as cancelled without completing", async () => {
    const ac = new AbortController();
    const w = fakeEvm({ personal_sign: () => new Promise(() => {}) });
    const { api, complete } = fakeApi();
    const p = run(envOf({ evm: w.provider }), api, { signal: ac.signal });
    await vi.waitFor(() => expect(w.calls.some((c) => c.method === "personal_sign")).toBe(true));
    ac.abort();
    expect(await codeOf(p)).toBe("cancelled");
    expect(complete).not.toHaveBeenCalled();
  });

  it("maps a chainId validation failure from the API to wrong_network", async () => {
    const f = http("VALIDATION_FAILED", 422, { fieldErrors: [{ field: "chainId", message: "chain is not enabled for sign-in" }] });
    expect(await codeOf(run(envOf({ evm: fakeEvm({ eth_chainId: () => "0x5" }).provider }), fakeApi({ challenge: { ok: false, error: f } }).api))).toBe("wrong_network");
  });

  it("maps an invalid/expired challenge on completion to challenge_invalid", async () => {
    const f = http("CHALLENGE_INVALID", 401);
    expect(await codeOf(run(envOf({ evm: fakeEvm().provider }), fakeApi({ complete: { ok: false, error: f } }).api))).toBe("challenge_invalid");
  });
});

describe("TRON flow", () => {
  const tronWeb = (sign: () => Promise<string>, host = "https://api.trongrid.io") => ({
    defaultAddress: { base58: "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC" }, fullNode: { host }, trx: { signMessageV2: sign },
  });

  it("requests accounts, derives the network from the node host and signs with signMessageV2", async () => {
    const msg = SIWE.replace("Ethereum", "TRON");
    const sign = vi.fn(async () => "0xtronsig");
    const tronLink = { request: vi.fn(async () => ({ code: 200 })), tronWeb: tronWeb(sign, "https://nile.trongrid.io") };
    const { api, challenge } = fakeApi({ challenge: { ok: true, data: { ...CHALLENGE, message: msg } } });
    await expect(run(envOf({ tronLink }), api, { protocol: "tron" })).resolves.toBe("SESSION");
    expect(tronLink.request).toHaveBeenCalledWith({ method: "tron_requestAccounts" });
    expect(challenge).toHaveBeenCalledWith({ protocol: "tron", address: "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC", chainId: "nile", purpose: "login" }, expect.anything());
    expect(sign).toHaveBeenCalledWith(msg);
  });

  it("a declined TronLink prompt (string rejection) is rejected, not a failure", async () => {
    const tronLink = { request: async () => ({ code: 200 }), tronWeb: tronWeb(async () => { throw "Cancel"; }) };
    expect(await codeOf(run(envOf({ tronLink }), fakeApi().api, { protocol: "tron" }))).toBe("rejected");
  });

  it("denied account access (code 4001) is rejected", async () => {
    const tronLink = { request: async () => ({ code: 4001 }), tronWeb: tronWeb(async () => "x") };
    expect(await codeOf(run(envOf({ tronLink }), fakeApi().api, { protocol: "tron" }))).toBe("rejected");
  });

  it("no TronLink and no tronWeb is no_wallet", async () => {
    expect(await codeOf(run(envOf({}), fakeApi().api, { protocol: "tron" }))).toBe("no_wallet");
  });

  it("an accountsChanged window message during signing discards the signature", async () => {
    let fire: (a: string) => void = () => {};
    let release!: (s: string) => void;
    const tronLink = { request: async () => ({ code: 200 }), tronWeb: tronWeb(() => new Promise<string>((r) => { release = r; })) };
    const env = envOf({ tronLink, onTronMessage: (h) => { fire = h; return () => { fire = () => {}; }; } });
    const { api, complete } = fakeApi();
    const p = run(env, api, { protocol: "tron" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    fire("setNode");
    release("0xsig");
    expect(await codeOf(p)).toBe("wallet_changed");
    expect(complete).not.toHaveBeenCalled();
  });

  it("unrelated TronLink messages do not interrupt", async () => {
    let fire: (a: string) => void = () => {};
    const tronLink = { request: async () => ({ code: 200 }), tronWeb: tronWeb(async () => { fire("tabReply"); return "0xsig"; }) };
    const env = envOf({ tronLink, onTronMessage: (h) => { fire = h; return () => {}; } });
    await expect(run(env, fakeApi().api, { protocol: "tron" })).resolves.toBe("SESSION");
  });
});

describe("helpers", () => {
  it("chainIdToDecimal converts hex quantities and rejects garbage", () => {
    expect(chainIdToDecimal("0x1")).toBe("1");
    expect(chainIdToDecimal("0xa4b1")).toBe("42161");
    expect(() => chainIdToDecimal("1")).toThrow(WalletFlowError);
    expect(() => chainIdToDecimal(undefined)).toThrow(WalletFlowError);
  });
  it("toHex encodes UTF-8", () => {
    expect(toHex("Hi é")).toBe("0x486920c3a9");
  });
  it("tronNetworkFromHost", () => {
    expect(tronNetworkFromHost("https://api.trongrid.io")).toBe("mainnet");
    expect(tronNetworkFromHost("https://api.shasta.trongrid.io")).toBe("shasta");
    expect(tronNetworkFromHost("https://nile.trongrid.io")).toBe("nile");
    expect(tronNetworkFromHost("http://127.0.0.1:9090")).toBe("unknown");
  });
  it("describeChallenge reads the domain and chain without altering the message", () => {
    expect(describeChallenge(SIWE, "evm")).toEqual({ domain: "app.example.test", chain: "1" });
    expect(describeChallenge("x.test wants you to sign in with your TRON account:\nT\n\ns\n\nURI: u\nVersion: 1\nNetwork: nile\n", "tron")).toEqual({ domain: "x.test", chain: "nile" });
  });
  it("failureToError covers status classes", () => {
    expect(failureToError({ kind: "network" }).code).toBe("offline");
    expect(failureToError(http("RATE_LIMITED", 429, { retryAfterSeconds: 12 }))).toMatchObject({ code: "rate_limited", retryAfterSeconds: 12 });
    expect(failureToError(http("UNAVAILABLE", 503)).code).toBe("unavailable");
    expect(failureToError(http("STEP_UP_REQUIRED", 403)).code).toBe("step_up");
    expect(failureToError(http("IDENTITY_CONFLICT", 409)).code).toBe("identity_conflict");
    expect(failureToError(http("INTERNAL", 500)).code).toBe("failed");
  });
});
