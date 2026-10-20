import type { ObservedTransfer } from "@llmcrypto/domain";

export interface TransferRef {
  txHash: string;
  eventIndex: number;
  /** "" or null: native asset. */
  assetContract: string | null;
}

/**
 * Read-only view of one or more chains. The ONLY source of payment facts: nothing a customer submits (such as a
 * transaction hash) is ever an input. Implementations compute `confirmations` and `headBlock` themselves.
 *
 * Real RPC adapters are NOT implemented: the provider/network/finality decisions are BLOCKED (see
 * docs/operations/payments.md). Only the FakeChainClient exists.
 */
export interface ChainClient {
  getHead(network: string): Promise<{ blockNumber: bigint }>;
  /** Transfers (of any asset the adapter understands) whose destination is `address`. */
  getTransfersTo(network: string, address: string): Promise<ObservedTransfer[]>;
  /** The transfer if it is on the canonical chain, or null when it is not (never mined, or reorged out). */
  getTransfer(network: string, ref: TransferRef): Promise<ObservedTransfer | null>;
}
