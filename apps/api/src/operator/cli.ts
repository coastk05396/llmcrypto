/**
 * Operator CLI: grants or revokes operator status for a USER id, out of band (there is no HTTP route for this).
 *   pnpm --filter @llmcrypto/api operator grant <userId> [note]
 *   pnpm --filter @llmcrypto/api operator revoke <userId>
 * DATABASE_URL: "pglite:<dir>" (the only driver wired so far; the server must not hold the same directory open).
 */
import { loadConfig } from "../config";
import { migrate, openPglite } from "../db";
import { grantOperator, revokeOperator } from "./service";

const [cmd, userId, ...note] = process.argv.slice(2);
const url = process.env["DATABASE_URL"] ?? "";
if ((cmd !== "grant" && cmd !== "revoke") || !userId) {
  console.error("usage: operator grant <userId> [note] | operator revoke <userId>");
  process.exit(2);
}
if (!url.startsWith("pglite:")) {
  console.error('DATABASE_URL must be "pglite:<dir>"');
  process.exit(2);
}
const config = loadConfig(process.env);
const db = await openPglite(url.slice("pglite:".length));
await migrate(db, config.migrationsDir);
if (cmd === "grant") {
  await grantOperator(db, { userId, grantedBy: "cli", ...(note.length ? { note: note.join(" ") } : {}), at: new Date() });
  console.log(`granted operator to ${userId}`);
} else {
  console.log((await revokeOperator(db, userId, new Date())) ? `revoked operator ${userId}` : `${userId} was not an active operator`);
}
await db.close();
