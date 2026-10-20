/// <reference lib="dom" />
/**
 * Tasks 20 and 21 frontend against the REAL apps/api (PGlite). Gateway requests use the deterministic FakeProvider.
 * Connectivity uses the in-process FakeChannelProvider (Telegram) wired by tests/e2e/api-server.ts; WhatsApp has no provider,
 * so it is genuinely "not configured". No real Telegram or WhatsApp message is ever sent or received.
 */
import { DEFAULT_OPTIMIZATION_CONFIG } from "@llmcrypto/contracts";
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { ageSessions, apiCall, apiSignIn, channelFailNext, channelSend, channelSent, chatCompletion, fundedAccount, uniqDigits, uniqName, useSession } from "./api-helpers";
import { installWallet, newEvm } from "./wallet-mock";

async function projectFor(session: string, name = uniqName("proj_")): Promise<{ id: string; name: string }> {
  const r = await apiCall(session, "POST", "/api/projects", { name });
  expect(r.status).toBe(201);
  return { id: String(r.json["id"]), name };
}

test.describe("Project memory (real API)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("create a project, add a note only with storage consent, edit, and delete with confirmation", async ({ page, context }) => {
    const { session } = await fundedAccount();
    await useSession(context, session);
    await page.goto("/app/memory");
    await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible();
    const name = uniqName("alpha_");
    await page.getByLabel("New project name").fill(name);
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByRole("heading", { name: `Notes in ${name}` })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No notes in this project" })).toBeVisible();
    // duplicate name (case-insensitive) is refused
    await page.getByLabel("New project name").fill(name.toUpperCase());
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "already used" })).toBeVisible();
    const projectId = new URL(page.url()).searchParams.get("project")!;

    // no consent, nothing stored
    await page.getByLabel("New note").fill("Deploys go out on Tuesdays.");
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(page.getByText("Storage consent is required.")).toBeVisible();
    expect((await apiCall(session, "GET", `/api/projects/${projectId}/memories`)).json["items"]).toHaveLength(0);

    await page.getByLabel(/I consent to storing this text/).check();
    await page.getByLabel(/Allow this note to be added to requests for this project/).check();
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Note saved" })).toBeVisible();
    const note = page.getByTestId("note");
    await expect(note).toContainText("Deploys go out on Tuesdays.");
    await expect(note).toContainText("Inject on");
    const stored = (await apiCall(session, "GET", `/api/projects/${projectId}/memories`)).json["items"];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ text: "Deploys go out on Tuesdays.", version: 1, inject: true });

    // edit
    await note.getByRole("button", { name: /^Edit note version 1/ }).click();
    const dlg = page.getByRole("dialog", { name: "Edit note" });
    await dlg.getByLabel("Note text").fill("Deploys go out on Wednesdays.");
    await dlg.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Write the text and tick the storage consent to save.")).toBeVisible();
    await dlg.getByLabel(/I consent to storing this text/).check();
    await dlg.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Note saved as version 2" })).toBeVisible();
    await expect(page.getByTestId("note")).toContainText("Wednesdays");

    // delete needs confirmation, focus starts on Cancel, then the note is really gone
    await page.getByRole("button", { name: /^Delete note version 2/ }).click();
    const del = page.getByRole("dialog", { name: "Delete this note?" });
    await expect(del.getByRole("button", { name: "Cancel" })).toBeFocused();
    await del.getByRole("button", { name: "Cancel" }).click();
    expect((await apiCall(session, "GET", `/api/projects/${projectId}/memories`)).json["items"]).toHaveLength(1);
    await page.getByRole("button", { name: /^Delete note version 2/ }).click();
    await page.getByRole("dialog", { name: "Delete this note?" }).getByRole("button", { name: "Delete note" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Note deleted" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No notes in this project" })).toBeVisible();
    expect((await apiCall(session, "GET", `/api/projects/${projectId}/memories`)).json["items"]).toHaveLength(0);
  });

  test("a concurrent edit is a visible conflict: both texts are shown and nothing is silently overwritten", async ({ page, context }) => {
    const { session } = await fundedAccount();
    await useSession(context, session);
    const p = await projectFor(session);
    const created = await apiCall(session, "POST", `/api/projects/${p.id}/memories`, { text: "original", storageConsent: true });
    const id = String(created.json["id"]);
    await page.goto(`/app/memory?project=${p.id}`);
    await page.getByRole("button", { name: /^Edit note version 1/ }).click();
    const dlg = page.getByRole("dialog", { name: "Edit note" });
    await dlg.getByLabel("Note text").fill("my local edit");
    await dlg.getByLabel(/I consent to storing this text/).check();
    // another writer saves version 2 first
    expect((await apiCall(session, "PUT", `/api/projects/${p.id}/memories/${id}`, { text: "their edit", expectedVersion: 1, storageConsent: true })).status).toBe(200);
    await dlg.getByRole("button", { name: "Save changes" }).click();
    const conflict = dlg.getByTestId("version-conflict");
    await expect(conflict).toContainText("This note changed elsewhere");
    await expect(conflict.getByTestId("theirs")).toHaveText("their edit");
    await expect(conflict.getByTestId("yours")).toHaveText("my local edit");
    expect((await apiCall(session, "GET", `/api/projects/${p.id}/memories/${id}`)).json["text"]).toBe("their edit"); // untouched
    // an explicit choice re-bases on version 2 and saves as version 3
    await conflict.getByRole("button", { name: "Keep my text and save over version 2" }).click();
    await dlg.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Note saved as version 3" })).toBeVisible();
    const final = (await apiCall(session, "GET", `/api/projects/${p.id}/memories/${id}`)).json;
    expect(final).toMatchObject({ text: "my local edit", version: 3 });
  });

  test("retention is saved with the settings version, and the JSON export downloads the stored notes", async ({ page, context }) => {
    const { session } = await fundedAccount();
    await useSession(context, session);
    const p = await projectFor(session);
    await apiCall(session, "POST", `/api/projects/${p.id}/memories`, { text: "exported note text", storageConsent: true });
    await page.goto(`/app/memory?project=${p.id}`);
    await page.getByLabel("Delete notes after a number of days").check();
    await page.getByLabel("Days after last edit (1 to 365)").fill("400");
    await page.getByRole("button", { name: "Save retention" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Check the days" })).toBeVisible();
    await page.getByLabel("Days after last edit (1 to 365)").fill("30");
    await page.getByRole("button", { name: "Save retention" }).click();
    await expect(page.getByText("Retention saved")).toBeVisible();
    const settings = (await apiCall(session, "GET", `/api/projects/${p.id}/memory-settings`)).json;
    expect(settings).toMatchObject({ retentionDays: 30 });
    expect(settings["version"]).toBeGreaterThan(0);
    await page.reload();
    await expect(page.getByLabel("Days after last edit (1 to 365)")).toHaveValue("30");
    await expect(page.getByTestId("note")).toContainText("Expires");

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export JSON" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^project-memory-.*\.json$/);
    const body = JSON.parse(readFileSync(await file.path(), "utf8")) as { projectId: string; notes: { text: string }[]; settings: { retentionDays: number | null }; noteCount: string };
    expect(body.projectId).toBe(p.id);
    expect(body.notes.map((n) => n.text)).toEqual(["exported note text"]);
    expect(body.settings.retentionDays).toBe(30);
    await expect(page.getByText("Export downloaded")).toBeVisible();
  });

  test("usage evidence says which note version was used in which request", async ({ page, context }) => {
    const { session, secret } = await fundedAccount();
    await useSession(context, session);
    const p = await projectFor(session);
    const note = await apiCall(session, "POST", `/api/projects/${p.id}/memories`, { text: "inject me", storageConsent: true, inject: true });
    expect((await apiCall(session, "PUT", "/api/optimization/policy", { expectedVersion: 0, config: { ...DEFAULT_OPTIMIZATION_CONFIG, projectContext: { enabled: true, maxNotes: 5, maxChars: 2000 } } })).status).toBe(200);
    const r = await chatCompletion(secret, "use the project notes", { "X-Project-Id": p.id });
    expect(r.status).toBe(200);
    const usage = (await apiCall(session, "GET", "/api/usage")).json["items"] as { requestId: string }[];
    await page.goto(`/app/memory?project=${p.id}`);
    const ev = page.getByTestId("memory-usage");
    await expect(ev).toContainText(`Note ${note.json["id"]} version 1 used in request ${usage[0]!.requestId}`);
    await expect(ev).toContainText("injected");
    await expect(ev).not.toContainText("inject me"); // evidence never holds note text
  });
});

test.describe("Connectivity (real API, fake channel provider)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("channels are labelled honestly: Telegram is a test double, WhatsApp is not configured and cannot be paired", async ({ page, context }) => {
    const { session } = await apiSignIn(newEvm());
    await useSession(context, session);
    await page.goto("/app/connectivity");
    const tg = page.getByTestId("channel-telegram");
    await expect(tg).toContainText("Test double");
    await expect(tg).toContainText("nothing is really delivered");
    await expect(tg.getByRole("button", { name: "Pair Telegram" })).not.toHaveAttribute("aria-disabled", "true");
    const wa = page.getByTestId("channel-whatsapp");
    await expect(wa).toContainText("Not configured");
    const pairWa = wa.getByRole("button", { name: "Pair WhatsApp" });
    await expect(pairWa).toHaveAttribute("aria-disabled", "true");
    await pairWa.click({ force: true });
    await expect(page.getByTestId("pairing-panel")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Nothing paired" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No deliveries yet" })).toBeVisible();
  });

  test("pairing: code shown once, 422 until the user sends it, then a binding with chosen events; test message is delivered; unpair", async ({ page, context }) => {
    const { session } = await apiSignIn(newEvm());
    await useSession(context, session);
    await page.goto("/app/connectivity");
    await page.getByRole("button", { name: "Pair Telegram" }).click();
    const panel = page.getByTestId("pairing-panel");
    const code = (await panel.getByTestId("pairing-code").textContent())!.trim();
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    await panel.getByLabel(/LoopGuard noticed repeated identical requests/).check();
    // before the user sends the code: 422, the code is not consumed and the panel stays
    await panel.getByRole("button", { name: "Confirm pairing" }).click();
    await expect(panel).toContainText("Not paired yet");
    expect((await apiCall(session, "GET", "/api/connectivity/bindings")).json["items"]).toHaveLength(0);

    const sender = uniqDigits();
    await channelSend(sender, code);
    await panel.getByRole("button", { name: "Confirm pairing" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Paired Telegram" })).toBeVisible();
    await expect(page.getByTestId("pairing-panel")).toHaveCount(0);
    const binding = page.getByTestId("binding");
    await expect(binding).toContainText(sender.slice(-4));
    await expect(binding).not.toContainText(sender); // masked: only the last characters are shown
    await expect(binding.getByLabel(/LoopGuard noticed repeated identical requests/)).toBeChecked();
    await expect(binding.getByLabel("A deposit was credited")).not.toBeChecked();
    const api = (await apiCall(session, "GET", "/api/connectivity/bindings")).json["items"];
    expect(api).toHaveLength(1);
    expect(api[0].events).toEqual(["loop_guard"]);

    // the code is gone after a reload (shown once) and the binding persists
    await page.reload();
    await expect(page.getByTestId("pairing-code")).toHaveCount(0);
    await expect(page.getByTestId("binding")).toHaveCount(1);

    // preferences
    await page.getByTestId("binding").getByLabel("A deposit was credited").check();
    await page.getByRole("button", { name: "Save alerts" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Alert preferences saved" })).toBeVisible();
    expect(((await apiCall(session, "GET", "/api/connectivity/bindings")).json["items"][0].events as string[]).sort()).toEqual(["deposit_credited", "loop_guard"]);

    // test message: queued, then really handed to the (fake) channel with the fixed minimal template
    await page.getByRole("button", { name: "Send test message" }).click();
    await expect(page.getByText("Test message queued")).toBeVisible();
    const row = page.getByTestId("deliveries-table").getByRole("row", { name: /Test message/ });
    await expect(row.getByText("Sent")).toBeVisible({ timeout: 15_000 });
    const sent = (await channelSent()).filter((m) => m.to === sender);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/^LLM Gateway: This is a test message from your gateway console\. .*Open the console for details\.$/);
    // a second test inside the minute is refused with the wait stated
    await page.getByRole("button", { name: "Send test message" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "One test message per minute" })).toBeVisible();

    // unpair with confirmation
    await page.getByRole("button", { name: /^Unpair Telegram/ }).click();
    const dlg = page.getByRole("dialog", { name: "Unpair this destination?" });
    await expect(dlg.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dlg.getByRole("button", { name: "Unpair" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Unpaired Telegram" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Nothing paired" })).toBeVisible();
    expect((await apiCall(session, "GET", "/api/connectivity/bindings")).json["items"]).toHaveLength(0);
  });

  test("a permanently failed delivery is visible with its error code", async ({ page, context }) => {
    const { session } = await apiSignIn(newEvm());
    await useSession(context, session);
    await page.goto("/app/connectivity");
    await page.getByRole("button", { name: "Pair Telegram" }).click();
    const sender = uniqDigits();
    await channelSend(sender, (await page.getByTestId("pairing-code").textContent())!.trim());
    await page.getByRole("button", { name: "Confirm pairing" }).click();
    await expect(page.getByTestId("binding")).toBeVisible();
    await channelFailNext();
    await page.getByRole("button", { name: "Send test message" }).click();
    const failed = page.getByTestId("deliveries-table").getByRole("row", { name: /Test message/ });
    await expect(failed.getByText("Failed")).toBeVisible({ timeout: 15_000 });
    await expect(failed).toContainText("chat_not_found");
  });

  test("pairing after the sign-in window asks for step-up first", async ({ page, context }) => {
    const w = newEvm();
    const { session, accountId } = await apiSignIn(w);
    await useSession(context, session);
    await installWallet(page, w);
    await ageSessions(accountId);
    await page.goto("/app/connectivity");
    await page.getByRole("button", { name: "Pair Telegram" }).click();
    const panel = page.getByTestId("step-up");
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Sign in with an EVM wallet" }).click();
    await expect(page.getByTestId("step-up")).toHaveCount(0);
    await page.getByRole("button", { name: "Pair Telegram" }).click();
    await expect(page.getByTestId("pairing-code")).toBeVisible();
  });

  test("(mocked API) a 503 on pairing says the channel is not configured", async ({ page, context }) => {
    const { session } = await apiSignIn(newEvm());
    await useSession(context, session);
    await page.route("**/api/connectivity/pairings", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "no provider", requestId: "req_503" } }) })
        : route.continue());
    await page.goto("/app/connectivity");
    await page.getByRole("button", { name: "Pair Telegram" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Telegram is not configured" })).toBeVisible();
  });
});
