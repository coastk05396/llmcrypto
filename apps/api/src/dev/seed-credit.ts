/**
 * DEV/TEST ONLY CLI: credit an account in a local persistent PGlite database (stop the API first; the embedded
 * database allows one process).
 *   ALLOW_DEV_CREDIT=true DATABASE_URL=pglite:./.data npx tsx src/dev/seed-credit.ts <accountId> <microusd>
 */
import { migrate, openPglite } from "../db";
import { DEFAULT_MIGRATIONS_DIR } from "../config";
import { devCreditAccount } from "./credit";

const [accountId, amount] = process.argv.slice(2);
const url = process.env["DATABASE_URL"] ?? "";
if (process.env["ALLOW_DEV_CREDIT"] !== "true" || process.env["ALLOW_TEST_COMPONENTS"] !== "true") throw new Error("Set ALLOW_DEV_CREDIT=true and ALLOW_TEST_COMPONENTS=true to confirm this is a dev/test database");
if (!accountId || !amount || !/^[1-9][0-9]*$/.test(amount)) throw new Error("usage: seed-credit <accountId> <positive micro-USD integer>");
if (!url.startsWith("pglite:")) throw new Error('DATABASE_URL must be "pglite:<dir>"');
const db = await openPglite(url.slice("pglite:".length));
await migrate(db, DEFAULT_MIGRATIONS_DIR);
const r = await devCreditAccount(db, { accountId, amountMicrousd: BigInt(amount), at: new Date(), note: "seed-credit CLI" });
console.log(`credited ${amount} micro-USD to ${accountId} (ledger transaction ${r.transactionId})`);
await db.close();
