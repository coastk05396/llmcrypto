import type { LinkedIdentity } from "@llmcrypto/contracts";
import { describeFailure, type ApiFailure } from "./api";

export const protocolLabel = (i: Pick<LinkedIdentity, "protocol">) => (i.protocol === "evm" ? "EVM" : "TRON");

/** Maps an unlink failure to user copy; LAST_AUTH_METHOD is a guard, not an error to retry. */
export function unlinkFailureCopy(f: ApiFailure): { stepUp: boolean; message: string } {
  if (f.kind === "http" && f.code === "LAST_AUTH_METHOD") return { stepUp: false, message: "This is your only sign-in method, so it cannot be removed. Link another wallet first." };
  if (f.kind === "http" && f.code === "STEP_UP_REQUIRED") return { stepUp: true, message: "Removing a wallet needs a recent sign-in. Verify with your wallet, then try again." };
  if (f.kind === "http" && f.code === "NOT_FOUND") return { stepUp: false, message: "That wallet is already gone. The list was refreshed." };
  return { stepUp: false, message: `Could not remove the wallet. ${describeFailure(f)}` };
}
