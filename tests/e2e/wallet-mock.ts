/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { tronAddressFromBytes20, tronMessageDigest } from "../../apps/api/src/auth/tron";

/**
 * Injected mock wallets. Keys are generated at runtime and stay in the Node test process; the page only
 * receives an `exposeFunction` that signs, like a wallet extension would. The browser code under test is
 * unmodified and talks to window.ethereum / window.tronLink exactly as it would with a real wallet.
 */
export interface MockEvm {
  kind: "evm";
  account: PrivateKeyAccount;
  address: string;
}
export interface MockTron {
  kind: "tron";
  account: PrivateKeyAccount;
  address: string;
}
export const newEvm = (): MockEvm => {
  const account = privateKeyToAccount(generatePrivateKey());
  return { kind: "evm", account, address: account.address };
};
export const newTron = (): MockTron => {
  const account = privateKeyToAccount(generatePrivateKey());
  return { kind: "tron", account, address: tronAddressFromBytes20(Buffer.from(account.address.slice(2), "hex")) };
};

export interface MockControl {
  /** Next personal_sign / signMessageV2 is declined by the "user". */
  rejectNextSign(): Promise<void>;
  /** Signing prompts stay pending until releaseSign(); lets a test change account/chain mid-prompt. */
  holdSign(on: boolean): Promise<void>;
  releaseSign(): Promise<void>;
  setChainHex(hex: string): Promise<void>;
  emitAccountsChanged(accounts: string[]): Promise<void>;
  emitChainChanged(hex: string): Promise<void>;
  emitTronMessage(action: string): Promise<void>;
  signCount(): Promise<number>;
}

interface PageMock {
  chainHex: string;
  reject: boolean;
  hold: boolean;
  held: Array<() => void>;
  signs: number;
  listeners: Record<string, Array<(...a: unknown[]) => void>>;
}
type MockWindow = typeof globalThis & { __mock: PageMock; __signEvm?: (h: string, a: string) => Promise<string>; __signTron?: (m: string) => Promise<string>; ethereum?: unknown; tronLink?: unknown };

/** Installs a wallet before any page script runs. Pass undefined to leave the browser with no wallet at all. */
export async function installWallet(page: Page, wallet: MockEvm | MockTron | undefined, opts: { chainHex?: string; tronHost?: string } = {}): Promise<MockControl> {
  if (wallet?.kind === "evm") {
    await page.exposeFunction("__signEvm", (hex: string) => wallet.account.signMessage({ message: { raw: hex as `0x${string}` } }));
  }
  if (wallet?.kind === "tron") {
    await page.exposeFunction("__signTron", (message: string) => wallet.account.sign({ hash: tronMessageDigest(message) }));
  }
  await page.addInitScript(
    ({ kind, address, chainHex, tronHost }) => {
      const w = window as unknown as MockWindow;
      w.__mock = { chainHex, reject: false, hold: false, held: [], signs: 0, listeners: {} };
      const m = w.__mock;
      const gate = async () => {
        m.signs++;
        if (m.reject) {
          m.reject = false;
          throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        }
        if (m.hold) await new Promise<void>((r) => m.held.push(r));
      };
      if (kind === "evm") {
        w.ethereum = {
          async request({ method, params }: { method: string; params?: unknown[] }) {
            if (method === "eth_requestAccounts" || method === "eth_accounts") return [address];
            if (method === "eth_chainId") return m.chainHex;
            if (method === "personal_sign") {
              await gate();
              return w.__signEvm!(String(params?.[0]), String(params?.[1]));
            }
            throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
          },
          on(ev: string, h: (...a: unknown[]) => void) { (m.listeners[ev] ??= []).push(h); },
          removeListener(ev: string, h: (...a: unknown[]) => void) { m.listeners[ev] = (m.listeners[ev] ?? []).filter((x) => x !== h); },
        };
      } else if (kind === "tron") {
        w.tronLink = {
          async request() { return { code: 200, message: "ok" }; },
          tronWeb: {
            defaultAddress: { base58: address },
            fullNode: { host: tronHost },
            trx: {
              async signMessageV2(message: string) {
                try { await gate(); } catch { throw "Cancel"; }
                return w.__signTron!(message);
              },
            },
          },
        };
      }
    },
    { kind: wallet?.kind ?? "none", address: wallet?.address ?? "", chainHex: opts.chainHex ?? "0x1", tronHost: opts.tronHost ?? "https://api.trongrid.io" },
  );
  return {
    rejectNextSign: () => page.evaluate(() => { (window as unknown as MockWindow).__mock.reject = true; }),
    holdSign: (on) => page.evaluate((o) => { (window as unknown as MockWindow).__mock.hold = o; }, on),
    releaseSign: () => page.evaluate(() => { const m = (window as unknown as MockWindow).__mock; m.hold = false; m.held.splice(0).forEach((r) => r()); }),
    setChainHex: (hex) => page.evaluate((h) => { (window as unknown as MockWindow).__mock.chainHex = h; }, hex),
    emitAccountsChanged: (accounts) => page.evaluate((a) => { (window as unknown as MockWindow).__mock.listeners["accountsChanged"]?.forEach((h) => h(a)); }, accounts),
    emitChainChanged: (hex) => page.evaluate((h) => { const m = (window as unknown as MockWindow).__mock; m.chainHex = h; m.listeners["chainChanged"]?.forEach((f) => f(h)); }, hex),
    emitTronMessage: (action) => page.evaluate((a) => { window.postMessage({ isTronLink: true, message: { action: a } }, "*"); }, action),
    signCount: () => page.evaluate(() => (window as unknown as MockWindow).__mock.signs),
  };
}
