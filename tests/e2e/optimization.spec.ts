/// <reference lib="dom" />
/**
 * Task 19 frontend (Tuning, Context steering) against the REAL apps/api with the deterministic FakeProvider.
 * Numbers shown in the UI are compared with the server's own report. No real provider exists, so nothing here
 * measures real caching, savings or answer length: that is exactly what the UI must (and is asserted to) not claim.
 */
import { DEFAULT_OPTIMIZATION_CONFIG } from "@llmcrypto/contracts";
import { expect, test } from "@playwright/test";
import { ageSessions, apiCall, apiSignIn, chatCompletion, fundedAccount, useSession } from "./api-helpers";
import { installWallet, newEvm } from "./wallet-mock";

const usd = (micros: bigint) => {
  const whole = micros / 1_000_000n;
  let frac = (micros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${whole}.${frac}`;
};
const cfg = (patch: Record<string, unknown>) => ({ ...DEFAULT_OPTIMIZATION_CONFIG, ...patch });

test.describe("Tuning (real API)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("everything starts off, batching is unavailable with its reason, saving creates version 1", async ({ page, context }) => {
    const { session } = await fundedAccount();
    await useSession(context, session);
    await page.goto("/app/tuning");
    await expect(page.getByTestId("policy-version")).toContainText("Policy version 0 (defaults: everything off)");

    const batching = page.getByTestId("control-batching");
    await expect(batching).toContainText("Unavailable");
    await expect(page.getByTestId("unavailable-reason")).toContainText("No provider batch API is integrated");
    await expect(batching.getByRole("checkbox")).toHaveCount(0);

    // every available control is an explicit, unchecked opt-in with its privacy impact and tradeoff on screen
    for (const t of ["Prompt-cache accounting", "Route comparison", "LoopGuard"]) {
      await expect(page.getByRole("checkbox", { name: `Turn on ${t}` })).not.toBeChecked();
    }
    await expect(page.getByTestId("control-cache_accounting")).toContainText("Accounting only. It does not cause any caching");
    await expect(page.getByTestId("control-loop_guard")).toContainText("Enforcement can block legitimate retries");

    const save = page.getByRole("button", { name: /^Save as version/ });
    await expect(save).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("No changes to save.")).toBeVisible();

    await page.getByRole("checkbox", { name: "Turn on Prompt-cache accounting" }).check();
    await page.getByRole("checkbox", { name: "Turn on Route comparison" }).check();
    await page.getByLabel("Note for this version (optional)").fill("accounting on");
    await page.getByRole("button", { name: "Save as version 1" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved as version 1" })).toBeVisible();
    await expect(page.getByTestId("policy-version")).toContainText("Policy version 1");

    const policy = (await apiCall(session, "GET", "/api/optimization/policy")).json;
    expect(policy["version"]).toBe(1);
    expect(policy["config"]["cacheAccounting"]["enabled"]).toBe(true);
    expect(policy["config"]["routeComparison"]["enabled"]).toBe(true);
    expect(policy["config"]["loopGuard"]["enabled"]).toBe(false);
    expect(policy["note"]).toBe("accounting on");
  });

  test("a stale save is a conflict: nothing is overwritten, reload shows the newer version and drops local edits", async ({ page, context }) => {
    const { session } = await fundedAccount();
    await useSession(context, session);
    await page.goto("/app/tuning");
    await page.getByRole("checkbox", { name: "Turn on Route comparison" }).check();
    // someone else saves version 1 first
    const other = await apiCall(session, "PUT", "/api/optimization/policy", { expectedVersion: 0, config: cfg({ cacheAccounting: { enabled: true } }) });
    expect(other.status).toBe(200);
    await page.getByRole("button", { name: "Save as version 1" }).click();
    const conflict = page.getByTestId("policy-conflict");
    await expect(conflict).toContainText("The policy changed somewhere else");
    expect((await apiCall(session, "GET", "/api/optimization/policy")).json["config"]["routeComparison"]["enabled"]).toBe(false); // not overwritten
    await conflict.getByRole("button", { name: "Reload latest policy" }).click();
    await expect(page.getByTestId("policy-version")).toContainText("Policy version 1");
    await expect(page.getByRole("checkbox", { name: "Turn on Prompt-cache accounting" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Turn on Route comparison" })).not.toBeChecked();
  });

  test("history lists versions and revert appends a new version copying the old one", async ({ page, context }) => {
    const { session } = await fundedAccount();
    await useSession(context, session);
    expect((await apiCall(session, "PUT", "/api/optimization/policy", { expectedVersion: 0, config: cfg({ cacheAccounting: { enabled: true } }), note: "v1 cache" })).status).toBe(200);
    expect((await apiCall(session, "PUT", "/api/optimization/policy", { expectedVersion: 1, config: cfg({ routeComparison: { enabled: true } }), note: "v2 route" })).status).toBe(200);
    await page.goto("/app/tuning");
    await expect(page.getByTestId("policy-version")).toContainText("Policy version 2");
    const versions = page.getByTestId("policy-versions");
    await expect(versions.getByRole("row")).toHaveCount(4); // header + v2, v1, v0
    await expect(versions).toContainText("v1 cache");
    await page.getByRole("button", { name: "Revert to version 1" }).click();
    const dlg = page.getByRole("dialog", { name: "Revert to version 1?" });
    await expect(dlg).toContainText("creates version 3");
    await expect(dlg).toContainText("Cache accounting");
    await dlg.getByRole("button", { name: "Revert" }).click();
    await expect(page.getByRole("status").filter({ hasText: "version 1 re-applied as new version 3" })).toBeVisible();
    await expect(page.getByTestId("policy-version")).toContainText("Policy version 3");
    await expect(page.getByTestId("policy-version")).toContainText("reverted from version 1");
    const now = (await apiCall(session, "GET", "/api/optimization/policy")).json;
    expect(now["version"]).toBe(3);
    expect(now["config"]["cacheAccounting"]["enabled"]).toBe(true);
    expect(now["config"]["routeComparison"]["enabled"]).toBe(false);
    expect((await apiCall(session, "GET", "/api/optimization/policy/versions")).json["items"]).toHaveLength(4); // history kept: 3,2,1,0
  });

  test("LoopGuard enforcement needs a threshold and explicit consent, and then blocks the repeated request for real", async ({ page, context }) => {
    const { session, secret } = await fundedAccount();
    await useSession(context, session);
    await page.goto("/app/tuning");
    await page.getByRole("checkbox", { name: "Turn on LoopGuard" }).check();
    await page.getByRole("radio", { name: /^Enforce/ }).check();
    const consent = page.getByTestId("loopguard-consent");
    await expect(consent).toContainText("Legitimate retries of the same request may be refused");
    const save = page.getByRole("button", { name: "Save as version 1" });
    await expect(save).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("Fix the highlighted fields first.")).toBeVisible();
    await page.getByLabel("Threshold (identical requests)").fill("1");
    await expect(page.getByText("Threshold: a whole number from 2 to 1000.").first()).toBeVisible();
    await page.getByLabel("Threshold (identical requests)").fill("2");
    await save.click({ force: true }); // aria-disabled: still a no-op
    expect((await apiCall(session, "GET", "/api/optimization/policy")).json["version"]).toBe(0);
    await consent.getByRole("checkbox").check();
    await save.click();
    await expect(page.getByRole("status").filter({ hasText: "Saved as version 1" })).toBeVisible();
    const saved = (await apiCall(session, "GET", "/api/optimization/policy")).json["config"]["loopGuard"];
    expect(saved).toMatchObject({ enabled: true, mode: "enforce", threshold: 2, enforcementConsent: true });

    const first = await chatCompletion(secret, "loop guard e2e identical request", { "X-Run-Id": "loop-run" });
    expect(first.status).toBe(200);
    const second = await chatCompletion(secret, "loop guard e2e identical request", { "X-Run-Id": "loop-run" });
    expect(second.status).toBe(429);
    expect(second.json["error"]["code"]).toBe("loop_guard_blocked");

    await page.reload();
    const table = page.getByTestId("evidence-table");
    await expect(table.getByRole("row", { name: /LoopGuard.*blocked/ })).toBeVisible();
    await expect(page.getByTestId("report").getByText("Blocked", { exact: true }).locator("..")).toContainText("1");
  });

  test("report: insufficient data first, then cache accounting equals the server's numbers", async ({ page, context }) => {
    const { session, secret } = await fundedAccount();
    await useSession(context, session);
    expect((await apiCall(session, "PUT", "/api/optimization/policy", { expectedVersion: 0, config: cfg({ cacheAccounting: { enabled: true } }) })).status).toBe(200);
    await page.goto("/app/tuning");
    await expect(page.getByTestId("report").getByTestId("insufficient-data").first()).toBeVisible(); // no requests yet
    expect((await chatCompletion(secret, "report me [[fake:cached=4]] [[fake:output=40]]")).status).toBe(200);
    const oracle = (await apiCall(session, "GET", "/api/optimization/report")).json["cacheAccounting"];
    expect(oracle.status).toBe("ok");
    await page.reload();
    const r = page.getByTestId("cache-report");
    await expect(r).toContainText(`${usd(BigInt(oracle.baselineMicrousd))} USD`);
    await expect(r).toContainText(`${usd(BigInt(oracle.actualMicrousd))} USD`);
    await expect(r).toContainText("Difference from the provider's cached discount");
    // evidence is listed with the request id and applied status, and no prompt text appears anywhere
    const row = page.getByTestId("evidence-table").getByRole("row", { name: /Cache accounting/ }).first();
    await expect(row).toContainText("applied");
    await expect(page.locator("main")).not.toContainText("report me");
  });
});

test.describe("Context steering (real API)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("guidance: opt-in copy, preview shows the altered request, evidence is applied, report never claims a saving", async ({ page, context }) => {
    const { session, secret } = await fundedAccount();
    await useSession(context, session);
    await page.goto("/app/context");
    const guidance = page.getByTestId("control-concise_guidance");
    await expect(guidance).toContainText("Adds input tokens to every request (you pay for them)");
    await expect(guidance).toContainText("Off by default");
    await page.getByRole("checkbox", { name: "Turn on Concise guidance" }).check();
    const save = page.getByRole("button", { name: "Save as version 1" });
    await expect(save).toHaveAttribute("aria-disabled", "true"); // enabled but empty text
    await page.getByLabel("Guidance text (added as a system message)").fill("Answer in one short sentence.");
    await expect(page.getByText("29 of 500 characters.")).toBeVisible();
    await save.click();
    await expect(page.getByRole("status").filter({ hasText: "Saved as version 1" })).toBeVisible();

    // preview: what the provider would receive, with origins; nothing is charged
    const before = (await apiCall(session, "GET", "/api/accounts/current/balance")).json["postedMicrousd"];
    await page.getByLabel("Your message").fill("What is a ledger?");
    await page.getByRole("button", { name: "Preview request" }).click();
    const preview = page.getByTestId("preview-result");
    await expect(preview).toContainText("Nothing was sent, stored or charged");
    const msgs = preview.getByRole("list", { name: "Messages the provider would receive" }).getByRole("listitem");
    await expect(msgs).toHaveCount(2);
    await expect(msgs.nth(0)).toContainText("Added: concise guidance");
    await expect(msgs.nth(0)).toContainText("Answer in one short sentence.");
    await expect(msgs.nth(1)).toContainText("Your request");
    await expect(msgs.nth(1)).toContainText("What is a ledger?");
    expect((await apiCall(session, "GET", "/api/accounts/current/balance")).json["postedMicrousd"]).toBe(before);

    // a real request is served with guidance and recorded as applied evidence
    expect((await chatCompletion(secret, "What is a ledger?")).status).toBe(200);
    await page.reload();
    const row = page.getByTestId("evidence-table").getByRole("row", { name: /Concise guidance/ }).first();
    await expect(row).toContainText("applied");
    await expect(row).toContainText("addedUtf8Bytes");
    await expect(page.locator("main")).not.toContainText("Answer in one short sentence.".repeat(2));

    // report: insufficient data is the state, with counts but never a currency amount
    const g = page.getByTestId("report").getByTestId("insufficient-data").first();
    await expect(g).toContainText("Insufficient data");
    await expect(g).toContainText("Applied to 1 requests");
    await expect(g).not.toContainText(/USD|\$|saved|savings of/i);
    const oracle = (await apiCall(session, "GET", "/api/optimization/report")).json;
    expect(oracle["conciseGuidance"].status).toBe("insufficient_data");
  });

  test("enabling guidance after the sign-in window asks for step-up, keeps the form, and saves after a wallet signature", async ({ page, context }) => {
    const w = newEvm();
    const { session, accountId } = await apiSignIn(w);
    await useSession(context, session);
    await installWallet(page, w);
    await ageSessions(accountId);
    await page.goto("/app/context");
    await page.getByRole("checkbox", { name: "Turn on Concise guidance" }).check();
    await page.getByLabel("Guidance text (added as a system message)").fill("Be brief.");
    await page.getByRole("button", { name: "Save as version 1" }).click();
    const panel = page.getByTestId("step-up");
    await expect(panel).toContainText("Verify it is you");
    await panel.getByRole("button", { name: "Sign in with an EVM wallet" }).click();
    await expect(page.getByTestId("step-up")).toHaveCount(0);
    await expect(page.getByLabel("Guidance text (added as a system message)")).toHaveValue("Be brief.");
    await page.getByRole("button", { name: "Save as version 1" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved as version 1" })).toBeVisible();
  });

  test("project context: opt-in, budgets validated, saved with its limits", async ({ page, context }) => {
    const { session } = await fundedAccount();
    await useSession(context, session);
    await page.goto("/app/context");
    await page.getByRole("checkbox", { name: "Turn on Project context injection" }).check();
    await expect(page.getByTestId("control-project_context")).toContainText("sent to the model provider as reference data");
    await page.getByLabel("Notes per request").fill("25");
    await expect(page.getByText("Notes per request: a whole number from 1 to 20.").first()).toBeVisible();
    await page.getByLabel("Notes per request").fill("3");
    await page.getByLabel("Characters per request").fill("1500");
    await page.getByRole("button", { name: "Save as version 1" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved as version 1" })).toBeVisible();
    expect((await apiCall(session, "GET", "/api/optimization/policy")).json["config"]["projectContext"]).toEqual({ enabled: true, maxNotes: 3, maxChars: 1500 });
    const pc = page.getByTestId("report").getByRole("heading", { name: "Project context" }).locator("..");
    await expect(pc).toContainText("Insufficient data");
  });
});
