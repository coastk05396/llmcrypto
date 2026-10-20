/**
 * Deterministic in-memory chain for tests and local development. Not a network adapter.
 * Supports fixtures (send, mine, reorg out/in) and fault injection (failures, duplicate and reordered
 * deliveries, events hidden from address listings to simulate a missed log subscription).
 */
import { eventKey, normalizeAddress, normalizeContract, normalizeTxHash, type ObservedTransfer } from "@llmcrypto/domain";
import type { ChainClient, TransferRef } from "./chain-client";

export interface FakeSend {
  network: string;
  txHash: string;
  eventIndex?: number;
  /** "" or null: native. */
  assetContract?: string | null;
  from?: string;
  to: string;
  amountAtomic: bigint;
  /** false: submitted but not mined (0 confirmations). Default true: mined into the next block. */
  mined?: boolean;
  /** Overrides the network's chain id (to simulate a transfer on a different chain). */
  chainId?: string;
}

interface Stored {
  key: string;
  network: string;
  chainId: string;
  txHash: string;
  eventIndex: number;
  assetContract: string;
  from: string | null;
  to: string;
  amountAtomic: bigint;
  blockNumber: bigint; // 0n: pending
  blockHash: string;
  blockTime: Date;
  canonical: boolean;
  hidden: boolean;
}

type Method = "getHead" | "getTransfersTo" | "getTransfer";

export class FakeChainClient implements ChainClient {
  private readonly heads = new Map<string, bigint>();
  private readonly chainIds: Record<string, string>;
  private readonly transfers = new Map<string, Stored>();
  private readonly failures = new Map<Method, Error[]>();
  private failAllWith: Error | null = null;
  private hashSeq = 0;
  /** Return every listed transfer twice (duplicate delivery). */
  duplicateListings = false;
  /** Return listings in reverse order (out-of-order delivery). */
  reverseListings = false;

  constructor(chainIds: Record<string, string>, private readonly clock: () => Date, startHead = 1_000n) {
    this.chainIds = { ...chainIds };
    for (const n of Object.keys(chainIds)) this.heads.set(n, startHead);
  }

  head(network: string): bigint {
    const h = this.heads.get(network);
    if (h === undefined) throw new Error(`fake chain: unknown network ${network}`);
    return h;
  }
  mine(network: string, blocks = 1): void {
    this.heads.set(network, this.head(network) + BigInt(blocks));
  }

  send(s: FakeSend): void {
    const contract = normalizeContract(s.assetContract);
    const eventIndex = s.eventIndex ?? 0;
    const key = eventKey(s.network, s.txHash, eventIndex, contract);
    const mined = s.mined ?? true;
    if (mined) this.mine(s.network);
    this.transfers.set(key, {
      key, network: s.network, chainId: s.chainId ?? this.chainIds[s.network] ?? "unknown", txHash: normalizeTxHash(s.txHash), eventIndex, assetContract: contract,
      from: s.from ?? null, to: s.to, amountAtomic: s.amountAtomic, blockNumber: mined ? this.head(s.network) : 0n,
      blockHash: mined ? this.nextHash() : "pending", blockTime: this.clock(), canonical: true, hidden: false,
    });
  }
  /** Mines a pending transfer into the next block. */
  confirmPending(network: string, txHash: string, eventIndex = 0, assetContract: string | null = ""): void {
    const t = this.get(network, txHash, eventIndex, assetContract);
    this.mine(network);
    t.blockNumber = this.head(network);
    t.blockHash = this.nextHash();
    t.blockTime = this.clock();
  }
  /** The transfer leaves the canonical chain (reorg). */
  reorgOut(network: string, txHash: string, eventIndex = 0, assetContract: string | null = ""): void {
    this.get(network, txHash, eventIndex, assetContract).canonical = false;
  }
  /** The transfer is included again in a new block (new block hash, confirmations restart). */
  reorgIn(network: string, txHash: string, eventIndex = 0, assetContract: string | null = ""): void {
    const t = this.get(network, txHash, eventIndex, assetContract);
    this.mine(network);
    t.canonical = true;
    t.blockNumber = this.head(network);
    t.blockHash = this.nextHash();
  }
  /** Omit from getTransfersTo (a missed log), while getTransfer still finds it. */
  hideFromListing(network: string, txHash: string, eventIndex = 0, assetContract: string | null = "", hidden = true): void {
    this.get(network, txHash, eventIndex, assetContract).hidden = hidden;
  }

  /** The next call of `method` throws `error`. */
  failNext(method: Method, error: Error = new Error(`fake chain: injected ${method} failure`)): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), error]);
  }
  failAll(error: Error | null): void {
    this.failAllWith = error;
  }

  async getHead(network: string): Promise<{ blockNumber: bigint }> {
    this.maybeFail("getHead");
    return { blockNumber: this.head(network) };
  }
  async getTransfersTo(network: string, address: string): Promise<ObservedTransfer[]> {
    this.maybeFail("getTransfersTo");
    const to = normalizeAddress(address);
    const out = [...this.transfers.values()]
      .filter((t) => t.network === network && t.canonical && !t.hidden && normalizeAddress(t.to) === to)
      .map((t) => this.observe(t));
    if (this.reverseListings) out.reverse();
    return this.duplicateListings ? [...out, ...out] : out;
  }
  async getTransfer(network: string, ref: TransferRef): Promise<ObservedTransfer | null> {
    this.maybeFail("getTransfer");
    const t = this.transfers.get(eventKey(network, ref.txHash, ref.eventIndex, ref.assetContract));
    return t && t.canonical ? this.observe(t) : null;
  }

  private observe(t: Stored): ObservedTransfer {
    const head = this.head(t.network);
    return {
      network: t.network, chainId: t.chainId, txHash: t.txHash, eventIndex: t.eventIndex, assetContract: t.assetContract, from: t.from, to: t.to,
      amountAtomic: t.amountAtomic, blockNumber: t.blockNumber, blockHash: t.blockHash, blockTime: t.blockTime,
      confirmations: t.blockNumber === 0n ? 0 : Number(head - t.blockNumber + 1n), removed: false, headBlock: head,
    };
  }
  private get(network: string, txHash: string, eventIndex: number, assetContract: string | null): Stored {
    const t = this.transfers.get(eventKey(network, txHash, eventIndex, assetContract));
    if (!t) throw new Error("fake chain: unknown transfer");
    return t;
  }
  private nextHash(): string {
    return `0x${(++this.hashSeq).toString(16).padStart(64, "0")}`;
  }
  private maybeFail(method: Method): void {
    if (this.failAllWith) throw this.failAllWith;
    const q = this.failures.get(method);
    const e = q?.shift();
    if (e) throw e;
  }
}
