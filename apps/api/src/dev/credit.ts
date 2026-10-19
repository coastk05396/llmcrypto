/**
 * DEV/TEST ONLY credit mechanism. There is deliberately NO HTTP route for it: real funding arrives through
 * confirmed deposits (task 13/14). This helper posts a balanced ledger adjustment (funding_source -> customer
 * funds) so tests and local development can fund an account. It refuses to run when NODE_ENV=production.
 */
import { creditPostings, postTransaction } from "@llmcrypto/domain";
import { audit } from "../audit";
import { randomId } from "../crypto";
import type { Db } from "../db";

export interface DevCreditInput {
  accountId: string;
  amountMicrousd: bigint;
  at: Date;
  note?: string;
}

export async function devCreditAccount(db: Db, input: DevCreditInput): Promise<{ transactionId: string }> {
  if (process.env["NODE_ENV"] === "production") throw new Error("devCreditAccount is disabled when NODE_ENV=production");
  if (process.env["ALLOW_TEST_COMPONENTS"] !== "true") throw new Error("devCreditAccount needs ALLOW_TEST_COMPONENTS=true");
  if (input.amountMicrousd <= 0n) throw new RangeError("amountMicrousd must be positive");
  return db.tx(async (q) => {
    const found = await q.query("select 1 as x from accounts where id=$1", [input.accountId]);
    if (!found.length) throw new Error(`unknown account ${input.accountId}`);
    const sourceId = randomId("devcredit");
    const r = await postTransaction(q, {
      id: randomId("ltx"), accountId: input.accountId, kind: "adjustment", sourceType: "adjustment", sourceId,
      priceVersion: null, reason: `DEV/TEST ONLY credit${input.note ? `: ${input.note}` : ""}`, at: input.at,
      postings: creditPostings(input.accountId, input.amountMicrousd), newEntryId: () => randomId("le"),
    });
    await audit(q, {
      accountId: input.accountId, actorUserId: null, action: "ledger.dev_credit", targetType: "ledger_transaction", targetId: r.transactionId,
      at: input.at, metadata: { amountMicrousd: input.amountMicrousd.toString(), devOnly: true },
    });
    return { transactionId: r.transactionId };
  });
}
