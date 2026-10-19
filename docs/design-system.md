# Design system: Editorial ledger console

Status: design specification. Nothing here is implemented; no screen has been built or user-reviewed. Tokens live in `design/theme-tokens.json` (single source; CSS custom properties are generated or hand-mirrored from it). Screens are in `docs/design-screens.md`.

Naming: the product name is undecided. "LLM Gateway" is a placeholder wordmark used throughout. Do not use the reference site's name, logo, copy or illustration style. Identity is built from: a serif display face, ruled "ledger" lines, tabular monospace figures, and the gold-on-charcoal palette from the user's portfolio (rickchen.si, inspected 2026-10-18).

## 1. Concept

Editorial ledger: the console reads like a printed account book. Wide left-aligned columns, hairline rules instead of boxed cards, large tabular numerals for money, small-caps style labels, and serif headlines for page titles only. Density comes from rows and rules, not nested containers. No card-inside-card; at most one surface level above the page.

## 2. Color

Dark tokens are the user's portfolio values. Light tokens are **derived by us** (warm paper background, gold darkened to an ink-gold for text). Neither the light theme nor the status colors were supplied by the user.

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| bg | #202225 | #f6f3ec | page |
| surface | #25282d | #ffffff | panels, table body |
| bar | #2b2e34 | #ece7db | header, table head, toolbars |
| inset | #292e36 | #f0ece2 | code blocks, inputs, wells |
| text | #f0f2f5 | #1f2125 | body, amounts |
| muted | #b5bfce | #4a5260 | secondary text, labels |
| border | #49525f | #cfc8b8 | decorative hairlines only |
| borderStrong | #7b8695 | #6f7682 | input and control boundaries (3:1) |
| accent | #dfbb76 | #7a5710 | emphasis text, active-nav marker, key figures |
| connector | #aa8c56 | #8a6a2a | ledger leader lines, chart axes |
| button / buttonText | #dfb66d / #272017 | #dfb66d / #272017 | primary action |
| buttonBorder | #dfb66d | #7a5710 | primary button edge (needed on light) |
| link / focus / info | #8bc9ed | #0a5a85 | links, focus ring, informational |
| success | #48bb78 | #17703f | settled, active, credited |
| warning | #f0a45d | #8a4f00 | pending, stale, underpaid |
| danger | #f4908a | #b0231b | failed, revoked, error |
| pending | #b5bfce | #4a5260 | neutral in-progress |

Rules:
- Gold is for emphasis and the single primary action per view, not for status. Status colors never reuse gold.
- Color is never the only status signal: every status renders icon + text label (see section 5, Status badge).
- The decorative `border` token is intentionally below 3:1 and must not be the only boundary of an input, button, checkbox or chart.

### Contrast results (computed, WCAG 2.x relative luminance)

Method: a Python script (kept in the agent scratchpad, not committed) computed ratios for every foreground token against bg, surface, bar and inset (text-class tokens need 4.5:1), plus UI-component pairs (3:1) and chart series against bg and surface. Re-run whenever a color token changes.

- Result: 0 failures against the requirements above in both themes.
- One initial failure fixed: the light primary button fill (#dfb66d) is only 1.71:1 on bg and 1.90:1 on surface, so light mode uses a 1px `buttonBorder` (#7a5710, 5.93:1 on bg). Button label contrast is 8.47:1 in both themes.
- Dark text pairs: text 12.13 to 14.22; muted 7.33 to 8.59; accent 7.46 to 8.74; link 7.57 to 8.87; success 5.61 to 6.57; warning 6.59 to 7.72; danger 5.96 to 6.99.
- Light text pairs: text 13.07 to 16.12; muted 6.38 to 7.87; accent 5.32 to 6.57; link 6.05 to 7.46; success 4.97 to 6.13 (lowest, success on bar); warning 5.32 to 6.56; danger 5.49 to 6.77.
- UI pairs: borderStrong 3.70 to 4.32 dark, 3.88 to 4.58 light; focus ring 7.57 to 8.87 dark, 6.05 to 7.46 light; connector 4.64 to 5.01 dark, 4.54 to 5.03 light.
- Chart series (5 per theme): lowest 6.09 dark (green on surface), 5.53 light (green on bg); all above 3:1.
- Decorative `border`: 2.02 dark, 1.50 light on bg. Allowed only for non-essential rules.
- Not measured: text over gradients/images (none specified), hover/pressed/disabled states (disabled text is exempt from WCAG but must remain legible, use muted at 60 percent opacity only on non-essential controls), and real-device rendering. Implementation must be checked with a browser tool (axe or Lighthouse) and reviewed by the user.

## 3. Typography

All faces are system or self-hostable; no third-party font CDN at runtime (privacy, performance, CSP).

- Display (page titles, hero, section heads): `"Iowan Old Style", "Palatino Linotype", Palatino, "Source Serif 4", Georgia, serif`. Optionally self-host Source Serif 4 (SIL OFL) as WOFF2, `font-display: swap`, subset to Latin, with `size-adjust` matched to the fallback to limit CLS.
- Body/UI: system sans stack.
- Mono (amounts, IDs, keys, code): system mono stack; optionally self-host JetBrains Mono (OFL). Always `font-variant-numeric: tabular-nums slashed-zero`.
- Scale: xs 12, sm 14, base 16, lg 18, xl 22, 2xl 28, 3xl fluid 32 to 44, hero fluid 40 to 72, amount fluid 36 to 56 (exact line heights in the token file). Minimum body text 16px on mobile inputs (prevents iOS zoom).
- Money: balances and prices use mono, right-aligned in tables, with the currency/unit shown beside the number ("USD", "per 1M tokens"). Never abbreviate a charge in a ledger row. Precision follows the ledger spec (micro-USD storage); display rounding is stated in a footnote beside totals.
- Long unbroken strings (keys, request IDs, addresses): `overflow-wrap: anywhere` in prose, `middle truncation` plus full value on focus/tooltip and copy button in tables.

## 4. Spacing, radius, layout

- Spacing scale 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96 px. Page gutter 16px mobile, 32px desktop. Content max 76rem; reading width 68ch.
- Radii are small (2 / 4 / 8px) to keep the printed-ledger feel; pill only for status badges and filter chips.
- Rules: 1px hairline between rows, 2px `accent` or `connector` rule under section titles and above totals.
- Min touch target 44 x 44 px; spacing between adjacent targets at least 8px.
- Breakpoints: 390 (reference mobile, fluid from 320), 768, 1024, 1440 (reference desktop).

## 5. Components

Each component: states are default, hover, focus-visible, active, disabled, loading (where async), error (where input).

- Button. Primary: `button` fill, `buttonText`, 1px `buttonBorder`; at most one per view region. Secondary: transparent, 1px `borderStrong`, text color. Tertiary/link: `link` color, underline always on in running text. Destructive (revoke key): secondary with `danger` text and icon, confirmation dialog required. Loading: spinner replaced by static "In progress" label under reduced motion; button stays focusable with `aria-disabled="true"` and `aria-busy`, not `disabled`, to preserve focus.
- Focus ring. 2px solid `focus`, 2px offset, on every interactive element via `:focus-visible`. Never `outline: none` without replacement. Skip link as first focusable element.
- Input / select / textarea. `inset` fill, 1px `borderStrong`, label always visible above (no placeholder-only labels), helper text below, error text below with icon and `aria-describedby`; invalid sets `aria-invalid="true"`. Error summary at form top on submit, focus moves to it.
- Copy button. Icon + visible text "Copy" with accessible name "Copy <thing>"; on activation text becomes "Copied" for 2s and a polite live region announces "Copied <thing>"; failure shows "Copy failed, select text manually" and selects the text. Never copy secrets into logs.
- Status badge. Pill, 1px border in status color, text label in `text`/status color, leading icon with distinct shape per status: check (success, "Settled", "Active"), clock (pending), triangle (warning/stale/underpaid), x-circle (danger/failed/revoked), minus-circle (expired/disabled), info-circle (info). Icons are `aria-hidden`; the label carries meaning.
- Tabs. WAI-ARIA tabs: `tablist`, roving tabindex, arrow keys move and activate, Home/End jump; used for quickstart languages. Active tab marked with 2px `accent` underline plus bold weight (not color alone).
- Disclosure / FAQ. Native `<details><summary>`; summary is a full-width 44px+ target with a chevron that rotates (no rotation under reduced motion).
- Dialog. Native `<dialog>` or equivalent: focus trapped, labeled by its title, Escape closes (except when a one-time secret is displayed and unacknowledged, where Escape asks for confirmation), focus returns to the trigger.
- Toast. Only for non-critical confirmations, `role="status"`, 6s minimum, pausable on hover/focus, never the sole carrier of an error; errors persist inline.
- Banner (inline alert). Full-width ruled strip, icon + title + body + action; `role="alert"` only for new failures, `role="status"` otherwise.
- Skeleton. Static `inset` blocks with the exact final dimensions to avoid CLS; shimmer only when motion is allowed. Container sets `aria-busy="true"` and a visually hidden "Loading <thing>" status.
- Amount display. Label (muted, xs, uppercase tracking), figure (mono, amount size, `text`), unit, optional delta text. Available and held balance are always two separate figures.
- Theme control. See section 8.
- Icons: one outline family at 1.5px stroke on a 24px grid, `currentColor` (suggest a self-bundled open-source set such as Lucide, ISC license; confirm license when implemented). Icon-only buttons need `aria-label`.

## 6. Tables

- Semantic `<table>` with `<caption>` (visually hidden if redundant), `<th scope="col">`/`scope="row">`, no ARIA grid roles unless cell-level keyboard navigation is built.
- Header on `bar` with 2px bottom rule; rows separated by hairline; row hover uses `inset`; no zebra needed.
- Numeric columns right-aligned, mono, tabular. Status column uses Status badge. Timestamps show absolute time in the user's zone with the zone abbreviation; relative time in a `title` is optional, never the only form.
- Sortable columns: header contains a `<button>`, `aria-sort` on the `th`, icon plus visually hidden "sorted ascending" text.
- Pagination: explicit page controls with `nav aria-label="Pagination"`, count "Showing 21 to 40 of 312" (only when total is known; otherwise "Showing 21 to 40"). Filter changes announce the result count via a polite live region.
- At 390px: do not horizontally scroll the page. Tables with up to 4 key columns collapse to "stacked rows" (each row becomes a `dl`-style block with the primary value, status and amount on top); wide data tables (request logs, catalog) keep the table inside a focusable scroll region (`tabindex="0"`, `role="region"`, `aria-label`) with the first column sticky. Choose per table in `design-screens.md`.
- Empty, loading, error and zero-result states render inside the table body region with the same column header retained.

## 7. Charts

- Dashboards use few charts: spend over time (bar or line) and request status mix (stacked bar). Prefer bars for money. No pie or 3D.
- Each chart has: a heading, a one-sentence text summary (for example "Spend rose from X to Y over 7 days" generated from the data), a "View as table" toggle exposing the same data as a semantic table, and direct labels or an inline legend.
- Series use the five chart colors plus a distinct dash/marker pattern (token `chart.patterns`) so charts remain readable without color. Axis and gridlines use `connector` and `border`.
- Hover/focus tooltips are also reachable by keyboard: each data point group is focusable, arrow keys move between points, and the value appears in a persistent readout under the chart, not only in a floating tooltip.
- Sample or mock data is stamped "Example data" in the chart header whenever it is not live ledger data.
- Animation: draw-in at most 320ms; removed under reduced motion. No auto-playing carousels of charts.

## 8. Theme control and no-flash script

Requirement: Light, Dark and System, visible on every route (public header and console header; in the mobile menu for 390px). System follows `prefers-color-scheme` live while selected; an explicit choice persists across sessions.

Control: a three-option segmented control implemented as a `radiogroup` labeled "Theme" with radios "Light", "Dark", "System" (icon plus text label on desktop; icon plus visually hidden text where space is tight, never icon alone without an accessible name). Arrow keys move among options (native radio behavior). The control reflects the stored preference, not the resolved theme, so System shows as selected when System is chosen.

Storage: `localStorage` key `theme-preference` with values `light | dark | system`; absent means `system`. Wrap all storage access in try/catch (blocked storage must not break rendering; the choice then lasts only for the page lifetime). A cookie mirror is optional if server-rendered pages need the value; none is assumed.

DOM contract: `<html data-theme="light|dark">` holds the **resolved** theme; `<html data-theme-pref="light|dark|system">` holds the preference. CSS defines tokens on `:root` (dark, matching the user's palette and `color-scheme: dark`) and overrides under `:root[data-theme="light"]`. Set `color-scheme` to match so native controls and scrollbars follow. Provide `<meta name="color-scheme" content="dark light">` and update `<meta name="theme-color">` when the resolved theme changes.

Inline pre-paint script (must be synchronous, in `<head>` before any stylesheet that paints, under 600 bytes, and allowed by CSP via nonce or hash):

```html
<script>
(function () {
  var p = "system", d = document.documentElement;
  try { p = localStorage.getItem("theme-preference") || p; } catch (e) {}
  if (p !== "light" && p !== "dark") p = "system";
  d.setAttribute("data-theme", p === "dark" || (p === "system" && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light");
  d.setAttribute("data-theme-pref", p);
})();
</script>
```

The script sets only the two attributes. `color-scheme` follows from the CSS rules on `:root[data-theme]`, and `<meta name="theme-color">` is updated by the theme provider after load (the browser UI color may briefly use the static dark value on first paint in a light theme; accepted trade-off for a minimal blocking script).

CSP: this is an inline script, so a deployed Content-Security-Policy must allow it. The hash is of the exact bytes between `<script>` and `</script>` in `apps/web/index.html` (whitespace included), so any edit, or any build step that reformats the file, changes it. Compute it after the production build with `node -e "const h=require('fs').readFileSync('apps/web/dist/index.html','utf8');const b=h.match(/<script>([\\s\\S]*?)<\\/script>/)[1];console.log('sha256-'+require('crypto').createHash('sha256').update(b).digest('base64'))"` and put it in `script-src 'sha256-...'` (no `unsafe-inline`). No CSP is configured in this repository yet; that is a release task. Without the allowance the script is blocked and the page falls back to the OS theme via the CSS media query, so an explicit Light/Dark choice would flash until the app loads.

Runtime behavior (after hydration): on change, write the preference (try/catch), recompute the resolved theme, update attributes and `theme-color`. While preference is `system`, subscribe to `matchMedia('(prefers-color-scheme: dark)')` `change`; unsubscribe otherwise. Listen to the `storage` event so other tabs follow. Do not apply theme transitions to the whole page on change (suppress transitions for one frame to avoid a color flash cascade). If JavaScript is disabled, CSS falls back to `@media (prefers-color-scheme: light)` applied only when no `data-theme` attribute is present.

Acceptance checks: no visible flash on hard reload in each of 3 preferences with each OS theme (6 cases); `System` tracks an OS change without reload; focus ring and badges pass the contrast table in both themes; screenshots of every route at 390 and 1440 in both themes.

## 9. Motion and reduced motion

Principles: motion explains change (open/close, copy confirmation, row insertion), never decorates; no looping or auto-play by default.

- Durations: 120ms (hover, press), 200ms (disclosure, tab underline, toast), 320ms (dialog, chart draw-in). Easing `cubic-bezier(0.2, 0, 0, 1)`. Animate only `opacity` and `transform`.
- Hero and feature illustrations: manual previous/next and tab selection; an explicit Pause/Play button exists for any auto-advancing element, which starts **paused** (static first frame) to satisfy WCAG 2.2.2 and reduced motion without extra logic.
- `@media (prefers-reduced-motion: reduce)`: all transitions/animations resolve to 0ms or an opacity-only 1ms swap; no parallax, no draw-in, no spinner rotation (use a static progress label and `aria-busy`). Reduced motion follows the OS preference only; an in-app motion toggle is not planned (open decision O3).

## 10. Accessibility baseline (WCAG 2.2 AA target)

- Landmarks: `header`, `nav` (labeled), `main` (single, with `id` for skip link), `footer`. One `h1` per route; headings in order.
- Visible focus (2.4.7, 2.4.11 focus not obscured): sticky header and bottom nav must not cover the focused element; apply `scroll-padding-top/bottom` equal to their height.
- Target size (2.5.8): at least 24px minimum, 44px by this system.
- Status messages (4.1.3) via live regions as specified per component.
- Forms: labels, instructions, error identification, no CAPTCHA that blocks wallet sign-in without an alternative; autocomplete attributes on password/OTP (`one-time-code`).
- Wallet connect: buttons are real `<button>`s with names such as "Sign in with an EVM wallet" and "Sign in with a TRON wallet"; connection state is announced.
- Do not rely on hover for any information; do not use color alone; text resize to 200 percent and 320px reflow without loss.
- Language: `lang` attribute set; no language menu until translated content exists (per SPEC).

## 11. Content honesty rules (design-level)

- No testimonials, customer logos, user counts or uptime claims. Hero and feature copy states only what the product does once it exists; features behind feature flags (agent runs, repository graph, Design beta, context tuning) do not appear in public marketing until validated.
- Setup-guide status labels are exactly: "Tested with our service", "API format checked", "Documentation only". Default for unverified guides is "Documentation only".
- Prices, models and context windows come from the typed catalog and show "Updated <date>"; mock fixtures display "Example data".
- Savings figures appear only as clearly labeled examples or when computed from the user's own recorded usage and dated rates.
- Wallet/network names appear in billing copy only for pairs the product actually enables; unconfigured ones are omitted, not greyed.
