# Handoff — Mayor sheet reorg (HubSpot-mirrored layout, via new sheet)

**Status (2026-07-21):** **Implemented on branch `sheet-reorg-hubspot-layout`** in all three repos (`mayor-invoice`, `mayor-email-backend`, `mayor-tools`). The three repos turned out to be present on this machine after all, so every `[confirm in-repo]` item was resolved against the real files and all code was written. Tests pass: `node --test` in `mayor-email-backend` = 9/9; `node scripts/build-new-sheet.js --self-test` green. **Not deployed** — branches are committed, not merged/pushed. The remaining work is the live/human cutover (copy sheet → run transform → lockstep deploy + `MO_SHEET_ID` flip), gated to Marcus's low-traffic window.

**Portable + self-contained.** The full plan is inlined at the bottom of this file. A working copy also lives at `.claude/plans/resume-work-on-mayor-invoice-idempotent-platypus.md` (machine-local). The inlined plan below is authoritative for carrying this work elsewhere.

Pairs with — does **not** replace — the shared all-repo `HANDOFF.md` in this repo (deploy, env vars, gotchas). This file is the single-task handoff for the sheet reorg only.

---

## What's been done (branch `sheet-reorg-hubspot-layout`, all 3 repos)

**Open items — all resolved against the real files:**
- `INVOICE_PROPERTIES` (hermesMapping.js) confirms the block ordering exactly: Block 1 = its order + `payment_link_2` co-located; Block 2 = product/description/sizes/quantity/price ×5; Block 3 = embroidery, art_setup, sample_reimbursement, custom_label, shipping, payment_terms (drops `unstrike`, kept as 3 derived strikes); labels = the payload field names.
- `cleanDescription()` size regexes (hubspotFormat.js 87–88) are **colon-only**, but sizes are stored **hyphen-format** (`S-24 M-16 L-8`, per hermesMapping.test.js). So the transform's splitter is **broadened** to both forms — reusing the regexes verbatim would false-flag most rows.
- Backend **already uses `MO_SHEET_ID`** (googleStore.js:16) → env-var promotion is **mayor-invoice-only** (done in index.js + portal.js; the two scripts stay pinned to the old id).
- `mayor-tools` invoice generator **has** a per-item sizes input merged into description (index.html:819–821) → wired through as a separate `sizes` field.

**Canonical new row layout (Order Confirmations / Invoices), A..BA, 53 cols**, implemented identically in all four places (index.js `rowData`, googleStore.js `buildDetailRow`, portal.js `parseSheetRow`, build-new-sheet.js remap):
Block 1 A–I `order_number, club, address, shipping_address, ship_date, payment_link, payment_link_2, customer_email, product_page` · Block 2 J–AH `product×5, description×5, sizes×5, quantity×5, price×5` · Block 3 AI–AN `embroidery, art_setup, sample_reimbursement, custom_label, shipping, payment_terms` · Block 4 AO–BA `subtotal, total, date_label, strike_emb, strike_art, strike_ship, orig_price×5, in_hand_date, drive_pdf_link`.
(Fixed a latent bug: old code collided `in_hand_date`/`driveLink` at AU across the two writers — now separate columns AZ/BA.)

**Files changed:**
- `mayor-invoice`: `portal.js` (parseSheetRow + Order Info reads + emailHasOrders + 4× A:BA + SHEET_ID→MO_SHEET_ID), `index.js` (rowData + Order Info write + SHEET_ID→MO_SHEET_ID), `doc-render.js` (re-merge sizes at render), `scripts/fill-missing-fields.js` (pre-cutover comment; kept OLD letters — see below), `scripts/backend-data-cleanup.js` (old-layout comment), **new** `scripts/build-new-sheet.js`.
- `mayor-email-backend`: `hermesMapping.js` (description clean + separate sizes), `hermesMapping.test.js`, `doc-render.js`, `googleStore.js` (buildDetailRow + Order Info write + comments), `googleStore.test.js`. (`SHEET_ID` already `MO_SHEET_ID`.)
- `mayor-tools`: `index.html` (`generate()` sends description + separate sizes).

**Decision — `fill-missing-fields.js` kept on OLD column letters** (not rewritten to B→D/D→C). The plan's code-change section and its "Gaps" section conflicted; the coherent path is: run it **pre-cutover** against the OLD sheet, then `build-new-sheet.js` carries the filled values into the new sheet. So it stays old-letters + hardcoded old id with a loud PRE-CUTOVER warning; its log strings stay accurate (no cosmetic fix needed). `backend-data-cleanup.js` likewise stays old-layout + pinned.

**Tests:** `mayor-email-backend` `node --test` → 9/9. `mayor-invoice/scripts/build-new-sheet.js --self-test` → green (sizes split both formats, 53-col remap, Order Info permute, header lengths).

## What's NOT done — the live cutover (human + credentials required)

Nothing more is codeable from here; these need Google creds, Render access, and Marcus's window:
1. Copy the spreadsheet (Sheets "Make a copy" / Drive `files.copy`).
2. `GOOGLE_SERVICE_ACCOUNT='<json>' NEW_SHEET_ID='<copy id>' node scripts/build-new-sheet.js` (dry run) → review every FLAGGED sizes-split row with Marcus → `--confirm`.
3. Point a mayor-invoice branch at the copy via `MO_SHEET_ID`; smoke-test `/portal/orders`, an order-detail page, both PDF downloads (use the OKC row).
4. Low-traffic window: merge/deploy all 3 branches; set `MO_SHEET_ID`→new sheet on both Render services together; tell Matt. Old sheet = instant rollback.
5. Post-cutover: one live/HubSpot-test Hermes generation lands correctly-split in the new sheet with an unchanged PDF; run `node --test`.

## How to resume

Code is done on the branches. Pick up at the cutover steps above. Review the branch diffs first (`git -C <repo> diff main...sheet-reorg-hubspot-layout`). Nothing is pushed — hold all pushes until Marcus picks the window (live-money system).

---

# PLAN (authoritative, inlined)

# Reorganize the Mayor order sheet to mirror HubSpot's deal-property layout — via a new sheet

## Context

HubSpot is the system of record; a shared Google Sheet ("MO sheet", `152hyxQz87IwPYl2lgBCm6pKKSjYl1hoL-AuZu-wODbo`) is the operational spine. `mayor-email-backend` (the live Hermes agent) **writes** order rows to it from HubSpot deals; `mayor-invoice` (the portal + PDF generator) **reads** rows from it and also writes on `/generate`. Marcus wants the sheet restructured so its columns mirror HubSpot's deal-property organization, with **true field-type regrouping** of line items (all 5 Products together, then all 5 Descriptions, then a new Sizes block, then Quantity, then Price) rather than cosmetic header renames. This requires splitting HubSpot's `sizes_N` back out of the merged `description` text and re-merging only at PDF-render time so invoices look identical.

**Why a new sheet (decided with Marcus):** the same layout is hand-duplicated in two independent writers — `mayor-invoice/index.js` (`appendOrderToSheet`) and `mayor-email-backend/googleStore.js` (`buildDetailRow`, live, creating real orders right now). An in-place column rewrite of the live sheet would corrupt every order written during the window between "new code live" and "sheet migrated," and only one of the two writers is reachable from this checkout. Building a **new sheet as the new source of truth** converts that into: build → test → flip the pointer, with the untouched old sheet as an instant rollback.

## Environment constraint for this session

This checkout contains **only `mayor-invoice`** (no git remote configured, no `gh`, and `mayor-email-backend` / `mayor-tools` cannot be cloned from here). Every `mayor-invoice` claim below was verified against the real files. The `mayor-email-backend` and `mayor-tools` sections are specified from the draft + `HANDOFF.md` and are marked **[confirm in-repo]** — re-check exact lines against the actual files when that repo is reachable. **Per Marcus, this session's deliverable is this plan only — no code is committed here.** Implementation happens in a checkout where all repos are reachable.

## Cutover model: new sheet as source of truth

```
BUILD (offline, nothing live points at the new sheet yet)
  ┌────────────────────────────────────────────────────────────┐
  │ 1. Copy the whole spreadsheet (Drive/Sheets "Make a copy")  │
  │    → NEW sheet keeps ALL tabs incl. Users (auth), old layout│
  │ 2. transform script rewrites the 3 order tabs in the COPY   │
  │    old→new layout + splits sizes out of description         │
  │ 3. point a mayor-invoice branch (env SHEET_ID) at the COPY, │
  │    smoke-test portal + PDFs against it                      │
  └────────────────────────────────────────────────────────────┘
                              │
                              ▼
CUTOVER (lockstep — code + pointer switch together, both repos)
  old sheet ──(instant rollback)──┐
                                  ▼
  ┌──────────────────────┐   SHEET_ID → NEW     ┌──────────────────────┐
  │ mayor-invoice        │  new-layout reader/  │ mayor-email-backend  │
  │ read + /generate     │  writer code deploy  │ Hermes writer        │
  └──────────┬───────────┘        ▲             └──────────┬───────────┘
             │                    │                        │
             └──────────► NEW SHEET (new layout) ◄─────────┘
                          Users/other tabs carried over intact
```

**Lockstep is unavoidable and inherent:** new-layout code reads/writes by column index, so new code MUST run against the new sheet and old code MUST run against the old sheet — they are bound. The new sheet does not remove that; it makes the data migration a non-destructive offline copy done *ahead* of the switch, and makes rollback a pointer+revert rather than a reverse-migration.

**Optional, recommended:** promote the hardcoded `SHEET_ID` to an env var (`MO_SHEET_ID`) in both repos so a branch can be tested against the copy without a code fork, and so the production switch is a Render env change alongside the code deploy. Currently hardcoded in `mayor-invoice/index.js:54` and `mayor-invoice/portal.js:39` (and the backend's own constant [confirm in-repo]). See "Gaps" below — it is actually hardcoded in **four** mayor-invoice files, and two of them must stay pinned to the old sheet.

## Target schema

### Order Confirmations / Invoices tabs — new layout (A…~BA)

Column letters below are **derived from the block field-counts** as a concrete target; they shift if a field is added/removed, and the exact `INVOICE_PROPERTIES` order in `mayor-email-backend/hermesMapping.js` is authoritative for Block 1/3 ordering + the HubSpot-property→column-name labels **[confirm in-repo]**.

**Block 1 — HubSpot single-value properties** (A–I):
`A order_number · B club(Customer) · C c_billing_address(→address) · D shippingbilling_address(→shipping_address) · E ship_date · F payment_link · G payment_link_2 · H customer_email · I product_page`

**Block 2 — line items, field-type grouped** (J–AH) — the new part:
`product_1..5 (J–N, →item.url) · description_1..5 (O–S, →item.description, sizes NO LONGER merged in) · sizes_1..5 (T–X, NEW, →item.sizes) · quantity_1..5 (Y–AC) · price_1..5 (AD–AH)`

**Block 3 — remaining HubSpot single-value properties** (AI–AN):
`za_embroidery(→embroidery) · zb_art_setup(→art_setup) · z_sample_reimbursement(→sample_reimbursement) · custom_main_label(→custom_label) · shipping_cost(→shipping) · payment_terms`

**Block 4 — portal/computed-only, no HubSpot equivalent** (AO–BA):
`subtotal(computed) · total(computed) · date_label · strike_embroidery · strike_art · strike_shipping · orig_price_1..5 (AU–AY, mayor-tools was/now pricing) · in_hand_date · drive_pdf_link (googleStore.js's Drive-link column)`

Notes:
- `ship_date` lands in **column E** — same as today's Invoices/OC layout — so `fill-missing-fields.js`'s column-E ship-date write into those tabs needs no change.
- `strike_*` stays derived into 3 booleans at write time exactly as today (not stored as raw `unstrike`). Out of scope to change.
- Portal read range widens from `A:AV` to the new last column (`A:BA` at the counts above).

### Order Info tab — new layout (A–H)

Old (verified in `portal.js`): `A order_number · B email · C club · D ship_date · E status · F tracking_number · G date_delivered · H unused`
New: `A order_number · B club · C ship_date · D email · E status · F tracking_number · G date_delivered · H unused`

Only B/C/D permute (club/ship_date/email). **Status stays E, tracking stays F, date_delivered stays G** — so `index.js`'s hardcoded `Order Info!E{row}` status write and the backend's `setOrderStatus()` E/F/G writes need **no change**. Only the write-time value arrays for B/C/D and the read-side index mapping change.

## Code changes — `mayor-invoice` (verified)

**`portal.js`:**
- `parseSheetRow()` (191–252): rewrite the column-map comment and every `row[N]` read to Blocks 1–4. Replace the `itemOffsets` loop (203–222, currently 5 groups of `[url,desc,qty,price,origPrice]`) with 5 flat index arrays — `PRODUCT_IDX`, `DESC_IDX`, `SIZES_IDX`, `QTY_IDX`, `PRICE_IDX` — each item now also getting `sizes` (from the new Block 2 column) and `orig_price` sourced from the Block 4 `orig_price_1..5` group. Note `customer_email` moves from `row[1]` into Block 1's column H.
- `getOrdersFromSheet` (77–95) and `getAllOrdersFromSheet` (102–130): remap the `Order Info!A:H` reads for the B/C/D permutation — `club=r[1]`, `ship_date=r[2]`, `email=r[3]` (was `email=r[1]`, `club=r[2]`, `ship_date=r[3]`). `emailInList` currently keys on `r[1]`; move to `r[3]`.
- `emailHasOrders()` (170–179): currently reads `Order Info!A:B` and tests `r[1]`. Email moves to D → widen the range to `A:D` and test `r[3]`.
- `getOrderDetailData` (259, 272), `/confirmation` (465), `/invoice` (499): change the four literal `A:AV` ranges to the new last column (`A:BA`). `.find()`/`normalizeOrderNumber` lookups only touch column A → no other change.

**`index.js`:**
- `appendOrderToSheet()` `rowData` (120–142): rebuild in Block 1–4 order and length, including the new `sizes` columns. `get(i,'sizes')` returns `''` for direct/mayor-tools-originated orders that don't send sizes separately (non-breaking blank column).
- Order Info write array (181–182): reorder to `[order_number, club, ship_date, customer_email, 'Awaiting Customer Approval', '', '', '']`.
- Status-only write (203–205) and the whole `writeToSheet` row-finder: unchanged (still `Order Info!E`, still writes the full row from column A).

**`doc-render.js`:**
- Line 206 (`const descText = (item.description || '').replace(/\\n/g,'\n').replace(/ \/ /g,'\n');`): re-append `item.sizes` so the rendered cell is byte-identical to today's merged text (sizes last, `\n`-joined):
  `const descText = [((item.description||'').replace(/\\n/g,'\n').replace(/ \/ /g,'\n')), item.sizes].filter(Boolean).join('\n');`

**`scripts/fill-missing-fields.js`:**
- Order Info email write: column `B` → `D` (73). Order Info ship_date write: column `D` → `C` (84). Invoices/OC ship_date write stays column `E` (93). Must be rewritten to the new letters **or** run against the OLD sheet before cutover — whichever comes first chronologically.

## Code changes — `mayor-email-backend` [confirm in-repo]

Must land in the same cutover as the mayor-invoice changes; this is the live writer.
- `hermesMapping.js` `dealToRenderPayload()` (~44–51): stop building the merged `fullDesc`; set `description: desc` (cleaned, no sizes) and add `sizes: sizes` (already computed from `p['sizes_'+(i+1)]`) as a new line-item field.
- `hermesMapping.test.js` (~46): split the merged-description assertion into `description === 'Navy piqué'` and `sizes === 'S-24 M-16 L-8'`.
- `doc-render.js` (the backend's own copy): same sizes re-merge as mayor-invoice's line 206 — grep for the equivalent line, don't assume the line number matches.
- `googleStore.js`: rebuild `buildDetailRow()` (~51–76) to the identical Block 1–4 field list as `index.js`'s `rowData`, now sourcing `get(i,'sizes')` and placing `driveLink` in Block 4. Reorder `persistOrder()`'s Order Info write (~143–144) to `[order_number, club, ship_date, email, status, '', '', '']`. `setOrderStatus()` (E/F/G) unchanged. Update the header/`ponytail:` comment (~1–11, 48–50) that documents "the portal's detail tabs expect this exact column order" to the new layout — this comment previously caught this exact class of drift.
- Repoint the backend's `SHEET_ID`/`MO_SHEET_ID` to the new sheet at cutover.

## Code changes — `mayor-tools` [confirm in-repo]

Single-file `index.html` invoice builder. If it has a sizes field, wire it through so direct orders populate the new `sizes` column; if not, leave the column blank (non-breaking). Also check `mayor-invoice/mayor_invoice_launcher.html` (present in this repo) for the same — verified this session: it has **no** sizes input (only `font-size` CSS), so direct orders from the launcher leave the column blank, non-breaking.

## Gaps found in mayor-invoice column-footprint re-verification

Re-verified every `mayor-invoice` claim above against the live files (only mayor-invoice is reachable here). Line numbers and per-file changes hold. Three items were missing or underspecified:

1. **`scripts/backend-data-cleanup.js` is a fourth layout-coupled file, not just `build-new-sheet.js`'s pattern donor.** It reads old column indices directly — `subtotal: parseCurrency(r[22])`, `total: parseCurrency(r[25])`, and `items: [r[8], r[13], r[18]]` (old qty1-3) at line 67 — plus `A:AV` (lines 63, 118) and `A:H` (line 118). It's a one-off that already ran, so it does not need rewriting; but it hardcodes `SHEET_ID` (line 15), so a blanket find/replace promoting `SHEET_ID`→`MO_SHEET_ID` (the recommendation above) would silently repoint this old-layout script at the new sheet and make it read garbage columns. Leave it pinned to the old sheet ID and add an `// old-layout, pre-cutover only` comment; do not env-var it.

2. **`SHEET_ID` is hardcoded in four mayor-invoice files, not two.** The `MO_SHEET_ID` note above lists `index.js:54` and `portal.js:39`; it is also in `scripts/fill-missing-fields.js:12` and `scripts/backend-data-cleanup.js:15`. When promoting to the env var, decide per-file — both scripts should stay pinned to the old sheet (run pre-cutover), not blanket-replaced.

3. **`fill-missing-fields.js` log strings go stale.** Lines 72 (`"column B (email)"`) and 83 (`"column D (ship_date)"`) are console output that becomes wrong after the B→D / D→C column change. Log-only, cosmetic, but fix them alongside the `writeCell` column-letter changes so an operator isn't misled.

**Source-layout note for `build-new-sheet.js`:** the old order tabs are *interleaved* — items 1-3 occupy G–U, then the totals block (shipping/subtotal/embroidery/art/total) occupies V–Z, then items 4-5 occupy AA–AJ. The five line items are not contiguous in the source row, so the Block-2 remap (step 3 below) must not assume a flat five-item block on the read side. Confirmed from both `parseSheetRow`'s index map and `index.js`'s `rowData`.

## Build + transform script (new: `mayor-invoice/scripts/build-new-sheet.js`)

Reuses the dry-run / `--confirm` + `getSheets()` pattern from `scripts/backend-data-cleanup.js`. Runs against the **copied** spreadsheet's ID (nothing live reads it, so the rewrite is safe and re-runnable):

1. Prereq: copy the whole spreadsheet first (Sheets "Make a copy" or Drive API `files.copy`). This carries **Users and every other tab** over untouched — critical, since portal auth reads `Users!A:C`. The script takes the copy's ID as an arg/env.
2. For `Order Info`: read `A:H`, permute each row's B/C/D into the new order, write back; rewrite the header row.
3. For `Order Confirmations` and `Invoices`: read `A:AV`, remap Block 1/3/4 by field copy, and **split sizes** — reuse the exact size-line regexes from `mayor-email-backend/hubspotFormat.js` `cleanDescription()` (~lines 87–88) **[confirm in-repo]**; instead of filtering matching lines out, extract them into the new `sizes` column and keep the rest as `description`. This is the literal inverse of the merge that created the text, so it's reliable for any Hermes-written row. Rows where no line matches → `sizes: ''`, description unchanged; **flag each such row explicitly in dry-run** for manual review (unrecognized size format, or no size breakdown). (Read side is interleaved — see the source-layout note above.)
4. Dry-run prints a full per-row before/after diff (every flagged sizes-split row called out); reviewed manually before `--confirm`.
5. Write with `values.update` per row (sheet is small; no `deleteDimension` needed) and rewrite all three header rows to the new labels.

## Cutover sequencing

1. Land all code changes in both repos (branches), reviewed, not merged.
2. Copy the spreadsheet; run `build-new-sheet.js` dry-run against the copy until Marcus approves every flagged sizes-split row; run `--confirm`.
3. Point a mayor-invoice branch at the copy (via the `MO_SHEET_ID` env var) and smoke-test: `/portal/orders`, an order-detail page, and both PDF downloads render identically. Use a known row (e.g. the OKC order, figures known from the prior session) to eyeball the before/after.
4. Low-traffic window: merge/deploy both repos and switch `MO_SHEET_ID` → new sheet on both Render services together. Old sheet is the instant rollback (flip env back + revert). Tell Matt the window so he isn't mid-order.
5. Post-cutover: trigger one real (or HubSpot test-deal) Hermes generation; confirm it lands in the new sheet with a correctly split `sizes` column and an unchanged-looking PDF. Run `node --test` in `mayor-email-backend` for the updated `hermesMapping.test.js` assertions.

## Verification

- Portal: `/portal/orders` (admin all-orders + a customer login), an order-detail page, and the invoice + confirmation PDF downloads all render identically to pre-cutover.
- Data: spot-check the OKC row and a couple of multi-line-item rows in the new sheet against the old sheet.
- Backend: `hermesMapping.test.js` passes; one live/sandbox Hermes order writes the new layout end-to-end.
- Rollback rehearsal: confirm flipping `MO_SHEET_ID` back to the old sheet + reverting restores the prior behavior.

## Open items to confirm when the other repos are reachable

> **RESOLVED (2026-07-21).** All repos were reachable on this machine; every item below was confirmed against the real files and the code was implemented on branch `sheet-reorg-hubspot-layout`. See "What's been done" near the top for the answers. Left here as the original checklist.

- Exact `INVOICE_PROPERTIES` order and HubSpot-property→column-name labels in `hermesMapping.js` (drives Block 1/3 ordering). → confirmed; plan ordering matches.
- Exact size-line regexes in `hubspotFormat.js` `cleanDescription()` (drives the sizes split). → confirmed colon-only; splitter broadened to also handle hyphen form.
- Line numbers in `googleStore.js`, the backend `doc-render.js`, and `hermesMapping.js`. → confirmed; edits applied.
- Whether `mayor-tools` has a sizes input to wire through. → yes; wired through as a separate `sizes` field.
