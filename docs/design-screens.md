# Screen designs: Editorial ledger console

Status: layout specification for the selected concept, "Editorial ledger" dark console, using tokens in `design/theme-tokens.json` and components in `docs/design-system.md`. No mockup or implementation exists yet; this document is not evidence of working behavior. "LLM Gateway" is a placeholder name. All data shown in designs is **example data** and must be labeled as such until live.

Reference widths: 390 px (mobile) and 1440 px (desktop). Light and Dark apply to every screen; System follows the OS.

## 1. Journey and screen map

| Journey | Screens (route) | Acceptance link |
| --- | --- | --- |
| Visitor evaluates | Home `/` (hero, catalog, quickstart, billing, FAQ), Setup `/setup`, Docs `/docs` | A1 |
| Visitor signs in | Sign-in `/app` (wallet EVM, wallet TRON, then secondary methods) | A2, A7 |
| Customer first use | Overview `/app` (first-use state), Keys, first request | A4 |
| Customer funds | Deposits `/app/credits`, payment failure/review states | A3 |
| Customer inspects | Overview, Request detail `/app/usage/:id`, Keys `/app/keys` | A4 to A6 |

Out of scope for this document (designed later, listed in nav only when real): agent runs, connectivity, context steering, tuning, project memory, repository graph, Design beta, diagnostics (`/diag` follows the same patterns).

## 2. Navigation pattern

Concept: a **ruled index** rather than tabs of pills. Navigation items are text with a 2px `accent` marker on the active item and the page title set in the display serif.

Public (Home, Setup, Docs)
- 1440: top bar on `bar`, left wordmark "LLM Gateway"; links Models, Quickstart, Billing, FAQ, Setup, Docs (only sections that exist); right side theme control then "Sign in" (secondary) and "Open console" (primary, only if signed in; otherwise primary is "Sign in"). Sticky; hairline bottom rule.
- 390: sticky header with wordmark, theme control icon button, and a "Menu" button (`aria-expanded`, `aria-controls`). Menu opens a full-height panel (not a bottom tab bar on public pages): links as large 48px rows, theme radiogroup, Sign in. Focus moves to the panel heading, is trapped, Escape closes and returns focus to Menu. Page behind gets `inert`.

Console (`/app/*`)
- 1440: left rail 240px on `bar`: wordmark, then groups. Primary group: Overview, Usage and logs, Credits, API keys. Secondary group "More" lists only enabled beta/optimization items (collapsed by default). Bottom of rail: account label (truncated wallet address or username), theme control, Sign out. Content column max 76rem with 32px gutter.
- 390: top app bar (wordmark, page title, account menu). Bottom navigation with 4 destinations: Overview, Usage, Credits, Keys; a fifth "More" opens a sheet (theme, More group, account, sign out). Bottom bar is 56px plus `env(safe-area-inset-bottom)`; main gets matching bottom padding and `scroll-padding-bottom`. Items are icon plus visible text label, `aria-current="page"` on active, 2px accent top marker plus bold label.
- Both: skip link "Skip to content", `nav aria-label="Primary"` and "Console" respectively; no dead links; unavailable features are hidden, not greyed.
- Keyboard: Tab order is skip link, header/rail, main. Rail and bottom bar are plain links (no roving tabindex needed).

## 3. Homepage `/`

Section order: hero, how it works (short), catalog, quickstart, billing, FAQ, footer. Every section appears only if its data exists at build; the hero and catalog are the minimum.

### 3.1 Hero
- 1440: 12-column grid. Left 7 columns: eyebrow "Prepaid LLM gateway" (muted, xs, uppercase), `h1` in hero serif (copy proposal: "One account, one key, many models, paid in advance" - final copy needs product decision), supporting paragraph at most 2 sentences stating only verified capabilities, actions: primary "Open console" (to `/app`), secondary "Browse models" (to `#catalog`). Right 5 columns: a "ledger specimen" - a ruled table-like panel on `surface` showing an **example** request line (model, tokens in/out, unit rates, cost), labeled "Example data". It is static; no auto-play. Optional previous/next only if more than one specimen exists (starts paused).
- 390: single column: eyebrow, h1 (hero scale ~40px), paragraph, two full-width stacked buttons (48px), then the specimen below, simplified to 3 rows. Hero must fit above the fold at 390 x 844 down to the buttons.
- No testimonials, logos, counts or uptime claims.
- States: static page; no loading state. If catalog fetch fails, only the catalog section degrades (see 3.2).

### 3.2 Catalog `#catalog`
- Toolbar on `bar`: search input (label "Search models"), provider filter as a labeled group of toggle buttons (`aria-pressed`) or select at 390, capability filter. Result count live region.
- 1440 table columns: Model (display name + ID in mono with Copy), Provider, Input price per 1M tokens, Output price per 1M tokens, Context window, Capabilities (text chips), Availability (status badge). Footer note: "Prices updated <date>, source: catalog". Sortable by price/context.
- 390: stacked rows: name and provider on line one, ID with Copy button on line two, then a 2x2 grid of input price, output price, context, availability. Capabilities collapse into a "Details" disclosure.
- Copy: button "Copy ID" with "Copied" feedback and live announcement.
- States: Loading - skeleton of 6 rows with fixed height, toolbar disabled via `aria-disabled`, status "Loading models". Empty filter result - inline message "No models match 'xyz'", with "Clear filters" button; focus stays on the search input. Error - banner (danger icon) "Could not load the catalog. Prices cannot be shown." with Retry button; stale cached data, if used, shows a warning badge "Last updated <date>". Zero models at launch - "No models are available yet" (no table).

### 3.3 Quickstart
- Tabs (WAI-ARIA) for only the protocols actually supported and tested (candidates per SPEC: Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, cURL; Gemini only after its adapter passes). Each panel: numbered steps in the margin column (serif numerals on a ruled leader), code block on `inset` with mono text, Copy button top-right, key shown as `YOUR_API_KEY`.
- 1440: steps at left (4 cols), code at right (8). 390: steps above, code full-bleed with horizontal scroll region (focusable, labeled) rather than wrapping.
- Guide-status label per example: "Tested with our service", "API format checked" or "Documentation only".

### 3.4 Billing
- Plain explanation, ruled three-step list: Deposit, Credit appears after confirmations, Usage deducts from available balance with a hold during requests. Table of supported asset and network pairs **only for pairs configured in production**; until then show "Supported networks are announced when payments open." Include the rule: available and held balance are shown separately; credits are prepaid.
- 390: steps stacked; table becomes stacked rows.

### 3.5 FAQ
- `<details>` list, each summary a 56px row with chevron, hairline rules. Questions limited to answers we can stand behind (billing model, key handling, data retention defaults, supported endpoints, what is not supported such as images if true). No expandable-all control needed. Deep-linkable by `id`.

### 3.6 Footer
- Links to Docs, Setup, Status (only if a status page exists), Terms/Privacy (placeholders flagged as pending legal text), theme control repeated at 390.

## 4. Sign-in `/app`

Layout: 1440 - two columns on a ruled divider. Left (5 cols): serif heading "Sign in", short note about what a wallet signature does and does not do ("Signing proves you control the address. It does not send funds."). Right (7 cols): method list. 390: single column.

Methods, in order: "Sign in with an EVM wallet" (primary), "Sign in with a TRON wallet" (secondary, equal size), then a "Other ways to sign in" disclosure with password, Telegram code and API key (each only when implemented). They are separate buttons because EVM and TRON are separate accounts until explicitly linked; helper text says so.

Flow states
- Idle: buttons enabled.
- No wallet detected: inline info banner "No <EVM/TRON> wallet found in this browser. Install a wallet or use another method." (no dead end; other methods remain).
- Connecting / awaiting signature: button shows "Waiting for wallet" with `aria-busy`, a Cancel button appears; live region announces; challenge shows domain and chain in a readable box ("Domain: <host>, Chain: <name>") before the wallet prompt.
- Rejected signature: warning banner "Signature was declined. No account changes were made." with Try again.
- Wrong chain/domain, expired or replayed challenge: danger banner stating cause and "Start again" (generates a new challenge); never reveals whether an address has an account.
- Success: status "Signed in", redirect to Overview, focus on page `h1`.
- Session expired (A7): redirect to this screen with a banner "Your session expired. Sign in again to continue." and return to the previous path after success.
- Unauthorized deep link: same screen, banner "Sign in to view this page."
- Offline: banner "You are offline. Reconnect to sign in." with Retry; buttons remain visible.
- Password/Telegram/API-key forms: labeled inputs, error summary, `autocomplete` attributes, API-key field masked with a show toggle (`aria-pressed`); the API-key method explains it opens a restricted view if that is the product behavior (open decision O2).

## 5. Console Overview `/app`

Priority order (SPEC): available credit, active key status, recent cost, first-request path.

### 5.1 1440 layout
- Page title row: serif `h1` "Overview", right side: primary "Add credit" button.
- Row 1 "ledger header" across 12 columns, separated by vertical hairlines (not cards): Available credit (amount scale, mono, unit USD) | Held (smaller, muted label "Held for in-flight requests") | Spend, last 7 days | Active keys (count and status text, e.g. "2 active, 1 revoked").
- Row 2: left 8 columns - "Spend over time" chart (bar, with summary sentence and "View as table"); right 4 columns - "First request" checklist when incomplete (see first-use), otherwise "Connect a tool" with the endpoint URL, Copy, and link to Setup.
- Row 3: "Recent requests" semantic table, 8 rows, columns Time, Model, Key (name), Status (badge), Tokens in/out, Cost (right-aligned mono), row link to Request detail. "View all usage" link.
- Advanced optimization is not on this page except a single link in the More nav group when enabled.

### 5.2 390 layout
Single column in the same priority: Available credit (amount scale, full width) with Held beneath in muted text; "Add credit" full-width primary; Active keys line with status badge; Spend 7 days as a compact figure plus sparkline-style bar chart with text summary; First request / Connect a tool block; Recent requests as 5 stacked rows. Bottom nav present.

### 5.3 States
- First use (no credit, no key): Available credit "0.00 USD" with message "Add credit to send requests"; a 3-step checklist ruled list - 1 Add credit, 2 Create an API key, 3 Send a first request (copyable cURL using `YOUR_API_KEY`, endpoint and a model ID from the catalog). Each step shows a status badge (To do / Done), completed steps stay visible. Chart and table are replaced by explanatory empty states, not blank frames.
- Funded, no requests: checklist step 3 current; table empty state "No requests yet. Send one with the example above" with the cURL block.
- Loading: skeletons for each region with fixed heights; amounts show a skeleton bar (never "0.00" while loading); page `aria-busy`.
- Error (per region, isolated): banner inside the region "Could not load balance" with Retry; other regions continue. If the balance cannot be loaded, show "Balance unavailable" and disable nothing that is safe; the server still enforces holds.
- Stale: if data is older than the refresh window or the connection dropped, a warning badge "Updated <time>, may be out of date" with Refresh.
- Pending deposit: an info banner above Row 1 "1 deposit awaiting confirmations" linking to Deposits.
- Low credit (threshold TBD, open decision O4): warning badge beside Available credit with text "Low credit".
- Negative or held-exceeds states: never styled as success; shown with danger badge "Balance needs review" and a link to Credits.

## 6. API keys `/app/keys`

- Header: serif `h1` "API keys", primary "Create key".
- 1440 table: Name, Scope (text), Status (Active / Revoked / Expired badge), Spend cap and used (two numbers in mono), Last used (absolute time or "Never"), Created, Actions (Rotate, Revoke as an overflow menu with visible labels, keyboard operable). Key prefix shown in mono (last 4 characters only; the full secret is never shown again).
- 390: stacked rows: name and status badge; second line prefix and last used; third line cap bar with text "12.40 of 50.00 USD"; actions button "Manage" opening a sheet/dialog.
- Create dialog: fields Name (required), Scope, Spend cap (optional), explanatory text; submit disabled only while submitting (aria-busy). Creation uses an idempotency key (invisible).
- One-time reveal: after creation, a dialog shows the secret in a mono block with Copy and a required checkbox "I have stored this key" before Close is enabled; heading "Copy your key now, it will not be shown again"; Escape asks for confirmation; secret never placed in URL, toast or logs. If the reveal window has passed or the page was reloaded, the row shows "Secret not recoverable. Create a new key" (never a silent second key).
- Revoke: dialog naming the key, stating effect "Requests using this key will fail immediately", destructive button "Revoke key", focus starts on Cancel. After success: row badge becomes Revoked (x-circle icon) and a status message announces it.
- States: empty "No API keys yet" with Create key primary and the first-request explanation; loading skeleton rows; error banner with Retry; create failure inline in the dialog with the form preserved; cap reached or validation errors under fields with error summary; unauthorized -> sign-in with return path.

## 7. Request detail `/app/usage/:id`

- Breadcrumb "Usage / Request <id>" (`nav aria-label="Breadcrumb"`). Header: request ID in mono with Copy, status badge (Settled, Pending usage, Cancelled, Failed, Refunded as supported by the ledger), timestamp.
- 1440: two columns. Left (7): "Summary" definition list (`dl`): model requested, model served (shown separately; the product never silently switches), endpoint/protocol, key name, streaming yes/no, latency, finish reason, correlation ID if provided. Below: "Token usage" table by category (input, output, cached, other as reported) with units and the rate applied per category and the price version date. Right (5): "Cost" ledger statement on `surface`: lines (hold reserved, charge, released hold, adjustments) each with ledger entry ID and signed amount, a 2px rule, then **Total charged** in amount scale. Footer: "Prompt content is not stored" or "Prompt capture enabled until <date>" depending on the setting; no prompt body shown by default.
- 390: single column in order: status and cost total first, summary list, token table (stacked rows), ledger lines.
- States: Pending usage (reconciliation): warning badge "Awaiting provider usage", hold amount shown, text explaining the billing policy once defined (open decision O5); Failed pre-dispatch: "No charge" with released hold; Failed post-dispatch/unknown: "Charge under review" with explanation. Loading skeletons; Not found / not yours: neutral "Request not found" (same response for other accounts' IDs), link back to Usage; Error banner with Retry.

## 8. Deposits `/app/credits`

- Header: serif `h1` "Credits"; top row: Available credit and Held credit as two separate amounts, then "Add credit" primary.
- Tabs or ruled sections: "Deposits" (intents and their states) and "Ledger" (balance changes). Shared filters: date range, status.
- Add credit flow (dialog at 1440 as a side drawer 480px; full-screen sheet at 390): Step 1 choose asset and network from supported pairs only (radiogroup rows each with asset, network, "confirmations required N" from config), amount with min/max helper text, validation inline. Step 2 review: shows receiving address in mono with Copy and a QR code **with the address repeated as text** and warnings in plain text: "Send only <asset> on <network>. Other assets or networks may not be credited." plus expiry countdown as static text with timestamp ("Expires at 14:32 UTC", countdown not announced continuously). Step 3 status page (see below). Address and network are bound to the intent; changing the network starts a new intent.
- Deposit status page / row states with icon + label + explanation + next action:
  - Awaiting payment (clock): intent open, expiry shown.
  - Detected, confirming (clock): "Confirmations 3 of 12" as text plus a progress bar (`role="progressbar"` with values), updates announced politely at milestones only.
  - Credited (check): amount credited, ledger entry link. One credit per transaction regardless of duplicate deliveries.
  - Underpaid (triangle): received vs expected amounts, what happens next per policy (open decision O6).
  - Overpaid (triangle): excess handling per policy.
  - Wrong asset or wrong network (x-circle): "Funds were sent in an unsupported asset or network. Not credited automatically. Contact support with this reference" and a manual-review reference ID.
  - Expired (minus-circle): "Intent expired. Late payments are reviewed manually" per policy, button "Create new intent".
  - Reversed / reorganized (x-circle): credit removed with ledger reference and explanation.
  - Manual review (info): "Under review, no action needed" plus reference ID.
- 1440 table columns: Created, Asset/network, Amount expected, Amount received, Status (badge), Reference. 390: stacked rows.
- States: empty "No deposits yet" with Add credit; loading skeleton; list error with Retry; intent creation failure inline (including duplicate/in-progress idempotency conflict: "A deposit is already being created. Check the list or try again in a moment"); offline: banner and disabled create (aria-disabled with reason).
- Vouchers appear only if the feature exists.

## 9. Payment failure

Treated as a status inside Deposits plus entry points elsewhere, not a separate marketing page.
- Inline on a deposit row/detail: danger or warning banner leading with what happened, what is safe ("No funds were taken from your account balance here; the transfer is on-chain and not reversible by us" only if accurate - verify wording with payments owner), and the single next action (Create new intent, Contact support with reference ID, Wait for confirmations).
- Request-time insufficient credit (shown in console request log and as API error docs): row status "Rejected: insufficient credit" with link "Add credit"; Overview shows a danger banner "Requests are being rejected because available credit is below the reserved cost" while true.
- Copyable reference IDs for support in every failure state; no secrets, no private keys, no seed phrase prompts ever.
- 390: banners full-width; actions stacked, primary first.

## 10. Global empty, loading, error, success patterns

| State | Pattern |
| --- | --- |
| Empty (first use) | Serif sentence stating what belongs here, one primary action, optional example block. Never a blank frame or decorative illustration promising features. |
| Empty (filtered) | Echo the filter, offer Clear filters, keep focus on the filter control. |
| Loading | Fixed-size skeletons, static unless motion allowed, `aria-busy`, status text. Loads over 10s show "Still loading" with Retry. |
| Error | Banner with icon, plain cause, a Retry or next action, request/correlation ID in mono with Copy for 5xx. Field errors inline with summary. |
| Stale / offline | Warning badge with timestamp; offline banner persists until connectivity returns, then a polite "Back online" status. |
| Success | Inline status or toast ("Key revoked", "Copied"); destructive or financial success also persists in the relevant list. |
| Unauthorized | Navigate to sign-in with return path and expired-session message; never show partial data. |
| Pending | Clock badge plus what is awaited and last-checked time. |
| Validation | Error summary at top focuses on submit; each field has `aria-describedby`; messages say how to fix. |

## 11. Keyboard and focus summary

- Page load: focus at top; skip link first. Route changes in the console move focus to the `h1` (tabindex -1) and update `document.title`.
- Menus and sheets: trap focus, Escape closes, return focus to trigger. Dialogs: initial focus on first field, or on Cancel for destructive.
- Tabs: arrow keys, Home/End. Details: Enter/Space. Segmented theme control: arrow keys.
- Tables: links in rows are real `<a>` on the primary cell; whole-row click is an enhancement, not the only route.
- Copy and status feedback: always visible text plus polite live region.

## 12. Validation required before sign-off (not yet done)

1. User reviews rendered screenshots of every screen at 390 and 1440, in Light, Dark and System, including the states above. None exist yet.
2. Keyboard-only pass and screen-reader spot check per route; axe or Lighthouse accessibility run; focus-not-obscured check with sticky header and bottom nav.
3. Contrast re-check on rendered pages (token pairs already computed, see design-system.md section 2).
4. Responsive checks at 320, 390, 768, 1024, 1440 and 200 percent zoom; reduced-motion emulation; no-flash theme test (6 cases).

## 13. Open decisions

- O1 Final product name, wordmark and hero copy (placeholder used).
- O2 Whether API-key sign-in grants a restricted dashboard or only exchanges for a session; affects sign-in copy.
- O3 Whether to add an in-app motion toggle beyond the OS setting.
- O4 Low-credit threshold and whether alerts are in scope for launch.
- O5 Billing-policy wording for missing-usage reconciliation.
- O6 Policies for underpaid, overpaid, expired-late and wrong-network deposits (affects copy and actions in section 8).
- O7 Which supported asset/network pairs launch (billing table content).
- O8 Icon set license confirmation and whether serif fonts are self-hosted or system-only.
- O9 Whether a Status page and legal pages exist at launch (footer links).
