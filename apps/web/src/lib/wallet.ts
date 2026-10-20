import type { WalletChallenge, WalletChallengeRequest, WalletProtocol, WalletSessionRequest } from "@llmcrypto/contracts";
import type { ApiFailure, ApiResult } from "./api";

/**
 * Browser-wallet sign-in flow, independent of React so it can be tested with fake providers.
 * Rules (task 07/08): the server authors the message; the wallet signs it verbatim; any account or
 * chain change while a challenge is pending discards that challenge (nothing is sent to the API);
 * a declined signature ends in a usable state. No secret or signature is stored or logged here.
 */

export type WalletErrorCode =
  | "no_wallet"
  | "rejected"
  | "wallet_changed"
  | "cancelled"
  | "wrong_network"
  | "challenge_invalid"
  | "rate_limited"
  | "offline"
  | "unavailable"
  | "step_up"
  | "identity_conflict"
  | "unauthenticated"
  | "failed";

export class WalletFlowError extends Error {
  constructor(readonly code: WalletErrorCode, readonly retryAfterSeconds: number | null = null) {
    super(code);
  }
}

export type WalletPurpose = "login" | "link";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

export interface TronWebLike {
  defaultAddress?: { base58?: string | false };
  fullNode?: { host?: string };
  trx: { signMessageV2(message: string): Promise<string> };
}
export interface TronLinkLike {
  request(args: { method: string }): Promise<{ code?: number; message?: string } | undefined>;
  tronWeb?: TronWebLike | false;
}

export interface WalletEnv {
  evm: Eip1193Provider | undefined;
  tronLink: TronLinkLike | undefined;
  tronWeb: TronWebLike | undefined;
  /** Subscribes to TronLink window messages; returns the unsubscribe function. */
  onTronMessage(handler: (action: string) => void): () => void;
}

export interface WalletApi<T> {
  challenge(body: WalletChallengeRequest, signal: AbortSignal): Promise<ApiResult<WalletChallenge>>;
  complete(body: WalletSessionRequest, signal: AbortSignal): Promise<ApiResult<T>>;
}

export type WalletStage =
  | { stage: "connecting" }
  | { stage: "awaiting-signature"; domain: string; chain: string; address: string };

export interface FlowInput<T> {
  protocol: WalletProtocol;
  purpose: WalletPurpose;
  env: WalletEnv;
  api: WalletApi<T>;
  signal: AbortSignal;
  onStage(s: WalletStage): void;
}

const TRON_CHANGE_ACTIONS = new Set(["accountsChanged", "setAccount", "setNode", "disconnect"]);

export function toHex(text: string): string {
  let out = "0x";
  for (const b of new TextEncoder().encode(text)) out += b.toString(16).padStart(2, "0");
  return out;
}

/** EIP-1193 chain ids are hex quantities; the API takes the decimal string. */
export function chainIdToDecimal(hex: unknown): string {
  if (typeof hex === "string" && /^0x[0-9a-fA-F]+$/.test(hex)) return BigInt(hex).toString();
  if (typeof hex === "number" && Number.isSafeInteger(hex) && hex >= 0) return String(hex);
  throw new WalletFlowError("failed");
}

export function tronNetworkFromHost(host: string | undefined): string {
  const h = (host ?? "").toLowerCase();
  if (h.includes("shasta")) return "shasta";
  if (h.includes("nile")) return "nile";
  if (h.includes("api.trongrid.io")) return "mainnet";
  return "unknown";
}

function isUserRejection(e: unknown): boolean {
  if (typeof e === "string") return /cancel|reject|declin|denied/i.test(e);
  if (typeof e !== "object" || e === null) return false;
  const o = e as { code?: unknown; message?: unknown };
  if (o.code === 4001 || o.code === "ACTION_REJECTED") return true;
  return typeof o.message === "string" && /user (rejected|denied|cancel)|rejected the request|declined/i.test(o.message);
}

/** Maps an API failure from challenge/completion to a flow error. */
export function failureToError(f: ApiFailure): WalletFlowError {
  if (f.kind === "network") return new WalletFlowError("offline");
  if (f.kind === "invalid") return new WalletFlowError("failed");
  switch (f.code) {
    case "CHALLENGE_INVALID": return new WalletFlowError("challenge_invalid");
    case "RATE_LIMITED": return new WalletFlowError("rate_limited", f.retryAfterSeconds);
    case "STEP_UP_REQUIRED": return new WalletFlowError("step_up");
    case "IDENTITY_CONFLICT": return new WalletFlowError("identity_conflict");
    case "UNAUTHENTICATED": return new WalletFlowError("unauthenticated");
    case "VALIDATION_FAILED":
      return f.fieldErrors.some((e) => e.field === "chainId") ? new WalletFlowError("wrong_network") : new WalletFlowError("failed");
    default:
      return f.status === 503 || f.status === 502 || f.status === 504 ? new WalletFlowError("unavailable") : new WalletFlowError("failed");
  }
}

/** Reads the readable parts of the server-authored message for display; the signed text itself is never altered. */
export function describeChallenge(message: string, protocol: WalletProtocol): { domain: string; chain: string } {
  const domain = /^(\S+) wants you to sign in/m.exec(message)?.[1] ?? "unknown";
  const chain = protocol === "evm" ? /^Chain ID: (\d+)$/m.exec(message)?.[1] : /^Network: (\S+)$/m.exec(message)?.[1];
  return { domain, chain: chain ?? "unknown" };
}

interface Connected {
  address: string;
  chainId: string;
  /** Signs the exact message; throws WalletFlowError("rejected") when the user declines. */
  sign(message: string): Promise<string>;
  /** Registers a change listener; returns unsubscribe. */
  watch(onChange: () => void): () => void;
}

async function connectEvm(env: WalletEnv): Promise<Connected> {
  const p = env.evm;
  if (!p) throw new WalletFlowError("no_wallet");
  let accounts: unknown;
  try {
    accounts = await p.request({ method: "eth_requestAccounts" });
  } catch (e) {
    throw new WalletFlowError(isUserRejection(e) ? "rejected" : "failed");
  }
  const address = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
  if (!address) throw new WalletFlowError("rejected");
  let chainId: string;
  try {
    chainId = chainIdToDecimal(await p.request({ method: "eth_chainId" }));
  } catch (e) {
    throw e instanceof WalletFlowError ? e : new WalletFlowError("failed");
  }
  return {
    address,
    chainId,
    async sign(message) {
      try {
        const sig = await p.request({ method: "personal_sign", params: [toHex(message), address] });
        if (typeof sig !== "string" || !sig) throw new WalletFlowError("failed");
        return sig;
      } catch (e) {
        if (e instanceof WalletFlowError) throw e;
        throw new WalletFlowError(isUserRejection(e) ? "rejected" : "failed");
      }
    },
    watch(onChange) {
      const h = () => onChange();
      p.on?.("accountsChanged", h);
      p.on?.("chainChanged", h);
      return () => {
        p.removeListener?.("accountsChanged", h);
        p.removeListener?.("chainChanged", h);
      };
    },
  };
}

async function connectTron(env: WalletEnv): Promise<Connected> {
  if (!env.tronLink && !env.tronWeb) throw new WalletFlowError("no_wallet");
  if (env.tronLink) {
    let res: Awaited<ReturnType<TronLinkLike["request"]>>;
    try {
      res = await env.tronLink.request({ method: "tron_requestAccounts" });
    } catch (e) {
      throw new WalletFlowError(isUserRejection(e) ? "rejected" : "failed");
    }
    if (res?.code !== undefined && res.code !== 200) throw new WalletFlowError(res.code === 4001 ? "rejected" : "failed");
  }
  const web = (env.tronLink && env.tronLink.tronWeb) || env.tronWeb;
  const address = web && web.defaultAddress?.base58;
  if (!web || !address) throw new WalletFlowError("rejected"); // locked or no account selected
  return {
    address,
    chainId: tronNetworkFromHost(web.fullNode?.host),
    async sign(message) {
      try {
        const sig = await web.trx.signMessageV2(message);
        if (typeof sig !== "string" || !sig) throw new WalletFlowError("failed");
        return sig;
      } catch (e) {
        if (e instanceof WalletFlowError) throw e;
        // TronLink rejects with a plain string such as "Cancel"; anything thrown at this step is a declined prompt.
        throw new WalletFlowError(isUserRejection(e) || typeof e === "string" ? "rejected" : "failed");
      }
    },
    watch(onChange) {
      return env.onTronMessage((a) => {
        if (TRON_CHANGE_ACTIONS.has(a)) onChange();
      });
    },
  };
}

/**
 * Runs connect -> challenge -> sign -> complete. Resolves with the API result or throws WalletFlowError.
 * A wallet account/chain change or an abort at any point rejects the flow and the signature (if any) is dropped.
 */
export async function runWalletFlow<T>(input: FlowInput<T>): Promise<T> {
  const { protocol, purpose, env, api, signal, onStage } = input;
  const inner = new AbortController();
  const state: { reason: WalletErrorCode | null } = { reason: null };
  const stop = (code: WalletErrorCode) => {
    state.reason ??= code;
    inner.abort();
  };
  const onOuterAbort = () => stop("cancelled");
  if (signal.aborted) throw new WalletFlowError("cancelled");
  signal.addEventListener("abort", onOuterAbort, { once: true });
  let unwatch: (() => void) | undefined;
  let sent = false;
  const check = () => {
    if (state.reason) throw new WalletFlowError(state.reason);
  };
  // Wallet prompts may never settle (user ignores them); cancel and wallet changes must still end the flow.
  const interrupted = new Promise<never>((_, reject) => {
    inner.signal.addEventListener("abort", () => reject(new WalletFlowError(state.reason ?? "cancelled")), { once: true });
  });
  interrupted.catch(() => {}); // avoid an unhandled rejection when nothing is racing at abort time
  const guard = <V,>(p: Promise<V>): Promise<V> => Promise.race([p, interrupted]);
  try {
    onStage({ stage: "connecting" });
    const wallet = await guard(protocol === "evm" ? connectEvm(env) : connectTron(env));
    unwatch = wallet.watch(() => stop("wallet_changed"));
    check();
    const ch = await guard(api.challenge({ protocol, address: wallet.address, chainId: wallet.chainId, purpose }, inner.signal));
    check();
    if (!ch.ok) throw failureToError(ch.error);
    const shown = describeChallenge(ch.data.message, protocol);
    onStage({ stage: "awaiting-signature", domain: shown.domain, chain: shown.chain, address: wallet.address });
    const signature = await guard(wallet.sign(ch.data.message));
    check(); // a change during signing drops the signature unsent
    sent = true;
    // Past this point the signature is on its way: a late wallet event or cancel no longer discards it, so the
    // outcome the server reports is the outcome the user sees (never "cancelled" while a session was created).
    const done = await api.complete({ challengeId: ch.data.challengeId, signature }, new AbortController().signal);
    if (!done.ok) throw failureToError(done.error);
    return done.data;
  } catch (e) {
    if (e instanceof WalletFlowError && sent) throw e;
    if (state.reason) throw new WalletFlowError(state.reason);
    throw e;
  } finally {
    signal.removeEventListener("abort", onOuterAbort);
    unwatch?.();
  }
}

export function browserWalletEnv(): WalletEnv {
  const w = window as unknown as { ethereum?: Eip1193Provider; tronLink?: TronLinkLike; tronWeb?: TronWebLike };
  return {
    evm: w.ethereum,
    tronLink: w.tronLink,
    tronWeb: w.tronWeb,
    onTronMessage(handler) {
      const h = (e: MessageEvent) => {
        const data = e.data as { isTronLink?: boolean; message?: { action?: unknown } } | null;
        if (data?.isTronLink && typeof data.message?.action === "string") handler(data.message.action);
      };
      window.addEventListener("message", h);
      return () => window.removeEventListener("message", h);
    },
  };
}

/** User-facing copy per error. Never reveals whether an address already has an account. */
export function walletErrorCopy(code: WalletErrorCode, protocol: WalletProtocol, retryAfterSeconds: number | null): { tone: "info" | "warning" | "danger"; title: string; body: string } {
  const label = protocol === "evm" ? "EVM" : "TRON";
  switch (code) {
    case "no_wallet":
      return { tone: "info", title: `No ${label} wallet found`, body: `No ${label} wallet was found in this browser. Install a wallet or use another method.` };
    case "rejected":
      return { tone: "warning", title: "Signature was declined", body: "No account changes were made. You can try again." };
    case "wallet_changed":
      return { tone: "warning", title: "Wallet changed", body: "The wallet account or network changed while signing, so the request was discarded. Nothing was sent. Start again." };
    case "cancelled":
      return { tone: "info", title: "Cancelled", body: "Sign-in was cancelled. No account changes were made." };
    case "wrong_network":
      return { tone: "danger", title: "Network not accepted", body: `This service does not accept sign-in on the network your wallet is using. Switch your ${label} wallet to a supported network and start again.` };
    case "challenge_invalid":
      return { tone: "danger", title: "Sign-in request expired or was not accepted", body: "The signed request was expired, already used or did not verify. Start again to generate a new one." };
    case "rate_limited":
      return { tone: "warning", title: "Too many attempts", body: retryAfterSeconds ? `Wait ${retryAfterSeconds} seconds and try again.` : "Wait a moment and try again." };
    case "offline":
      return { tone: "danger", title: "Could not reach the API", body: "You may be offline. Reconnect and retry." };
    case "unavailable":
      return { tone: "danger", title: "Sign-in is temporarily unavailable", body: "The service could not complete the request. Try again shortly." };
    case "step_up":
      return { tone: "warning", title: "Recent sign-in required", body: "For this action, sign in again with your wallet, then retry." };
    case "identity_conflict":
      return { tone: "danger", title: "Wallet already linked elsewhere", body: "That wallet belongs to another account. Accounts are never merged automatically." };
    case "unauthenticated":
      return { tone: "danger", title: "Session ended", body: "Your session is no longer valid. Sign in again." };
    case "failed":
      return { tone: "danger", title: "Something went wrong", body: "The wallet or the API returned an unexpected response. Try again." };
  }
}
