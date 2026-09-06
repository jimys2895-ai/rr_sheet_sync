# RoseRocket → Google Sheets Sync

Automated, **one-way** sync that pulls operational data from **RoseRocket** into Google Sheets on a
recurring schedule. The **outbound** spreadsheet mirrors US Outbound loads; a separate **ops**
spreadsheet handles Force Deliver; the **commission** spreadsheet holds the JO Report. Built to run
unattended as **Render Cron Jobs**.

## Contents

- [Spreadsheets](#spreadsheets)
- [Outbound sheet — what it syncs](#outbound-sheet--what-it-syncs)
- [Summary tab](#summary-tab)
- [Force Deliver (ops sheet)](#force-deliver-ops-sheet)
- [Force Cancel (ops sheet)](#force-cancel-ops-sheet)
- [Force Delete Manifest (ops sheet)](#force-delete-manifest-ops-sheet)
- [JO Report (commission sheet)](#jo-report-commission-sheet)
- [Trip history (completed-trip archive)](#trip-history-completed-trip-archive)
- [Exchange rates (RoseRocket)](#exchange-rates-roserocket)
- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [RoseRocket setup](#roserocket-setup)
- [Google setup](#google-setup)
- [Force refresh from the outbound sheet](#force-refresh-from-the-outbound-sheet)
- [Environment variables](#environment-variables)
- [Local development](#local-development)
- [Deploy to Render (Cron Job)](#deploy-to-render-cron-job)
- [Maintenance](#maintenance)
- [Data & behavior details](#data--behavior-details)
- [Troubleshooting](#troubleshooting)
- [Cost & security](#cost--security)

## Spreadsheets

| Sheet          | Env var                      | Purpose                                                                  |
| -------------- | ---------------------------- | ------------------------------------------------------------------------ |
| **Outbound**   | `GOOGLE_OUTBOUND_SHEET_ID`   | US Outbound, Summary, + regional/tag tabs (manifests tagged `US O/B`)    |
| **Inbound**    | `GOOGLE_INBOUND_SHEET_ID`    | US Inbound, Summary, + regional/tag tabs (manifests tagged `US I/B`)     |
| **Ops**        | `GOOGLE_OPS_SHEET_ID`        | Force Deliver + Force Cancel + Force Delete Manifest queues              |
| **Commission** | `GOOGLE_COMMISSION_SHEET_ID` | JO Report — All Commission Current/Previous, rep tabs, Commission Lookup |
| **Trip history** | `GOOGLE_TRIP_HISTORY_SHEET_ID` | Archive of completed round trips — O/B, I/B, Rounder                  |

The **Inbound** sheet is identical to the Outbound sheet except it lists orders **originating** in the
USA and its nickname tabs trigger on the **`US I/B`** tag. Share **all** spreadsheets with the Google
service account email as **Editor**.

## Outbound sheet — what it syncs

The **US Outbound** master lists **every** US Outbound order (destination USA + Booked/In-Transit) —
tagged or not. The **per-nickname tabs are opt-in per manifest**: a manifest gets its own tab only
when it carries the **trigger tag** (`US O/B` by default; set `OUTBOUND_TRIGGER_TAG` to change it).
Any other manifest tags (old lane tags, etc.) are ignored.

Each run writes two fixed tabs plus **one tab per manifest nickname**, created dynamically from the
tagged manifests (no hardcoded tab list):

| Tab                           | Scope                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **US Outbound**               | All orders → destination USA + Booked/In-Transit (the full set, regardless of tag)                         |
| **Summary**                   | One row per nickname tab — see [Summary tab](#summary-tab) below                                           |
| **&lt;manifest nickname&gt;** | One tab per distinct nickname of a manifest tagged `US O/B` — the orders on that manifest                  |

Tabs are named after each manifest's **nickname** (`master_trip.nickname`, falling back to `message`).
The tab set follows the live tagged manifests: tag a manifest and its nickname tab appears next sync;
untag it (or a nickname no longer present) and the tab is removed — the orders still remain on **US
Outbound** either way. Fixed tabs come first (**US Outbound**, then **Summary**), the nickname tabs
follow in alphabetical order, and **Force Refresh** stays last. A tagged manifest with **no** nickname
yet gets no subset tab until it is named. Columns are as follows (the per-nickname subset tabs also
add **Miles** and **RPM**):

| Column          | Source field                                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **City**        | `to_city`                                                                                                                                                                                                                 |
| **State**       | `to_state`                                                                                                                                                                                                                |
| **Zip**         | `to_postal`                                                                                                                                                                                                               |
| **Skids**       | `total_skids`                                                                                                                                                                                                             |
| **Feet**        | `total_linear_feet`                                                                                                                                                                                                       |
| **Weight**      | `total_weight`                                                                                                                                                                                                            |
| **Rate**        | Dispatched quote `freight_cost` in **CAD** (line-haul only; USD quotes converted via quote FX)                                                                                                                            |
| **Customs**     | `order_tags` → names of customs tags on the order (whitelist in `sync.js`)                                                                                                                                                |
| **Customer**    | `billing_org_name`                                                                                                                                                                                                        |
| **Order ID**    | `full_id` (linked to the order)                                                                                                                                                                                           |
| **Manifest ID** | `master_trip.full_id` of the **delivery-leg (D-leg) manifest** — i.e. the line-haul run (linked to the manifest). A pickup leg's manifest is the _local driver_ and is ignored. Blank when that manifest has no nickname. |
| **Nickname**    | `master_trip.nickname` — **US Outbound** tab only                                                                                                                                                                         |
| **Notes**       | Free text on **US Outbound** — preserved across syncs (keyed by **Order ID**); edits and erasures stick                                                                                                                           |

To change the columns or their order, edit `buildSheetColumns` in [`src/sync.js`](src/sync.js).

### Summary tab

One row per nickname tab, with a totals row. Columns, left to right:

| Column | Notes |
| ------ | ----- |
| **Lane** | The nickname tab this row summarises |
| **City / State / Zip** | The lane's **last** stop — outbound: the final US delivery; inbound: the final US **pickup**, i.e. the last place the truck was before turning for Canada |
| **Driver** | From the manifest (falls back to the partner carrier for a brokered run) |
| **Type** | `OO` owner-operator, `CD` company driver, blank if unknown — read from RoseRocket's driver records |
| **Manifest ID** | Linked to the manifest when the lane is a single manifest |
| **Skids / Feet / Weight** | Summed across the lane's orders |
| **Actual** | Planner-entered footage, preserved across syncs (**inbound only**) |
| **Rate / Miles / RPM** | The leg's figures |
| **OO Rev / OO RPM** | The owner-operator share — filled in **only** for `OO` drivers |
| **Rounder Rate / Miles / RPM** | The whole round trip (**inbound only**) |
| **Rounder OO Rev / OO RPM** | Owner-operator share of the whole trip (**inbound only**) |
| **Notes** | Planner-entered text **and** fill colour, both preserved across syncs, keyed by Manifest ID |

#### OO Cut

**Row 1 holds an editable `OO Cut` percentage** and the table header sits on row 2. Every **OO Rev** cell
is a formula (`= Rate × $B$1`), so changing that one cell re-prices the whole tab instantly — no sync and
no redeploy. The value is read back before each refresh and rewritten, so a manual edit survives; it
starts at **59%**, matching the trip-history sheet.

#### Manifests dispatched to an outside carrier (inbound)

The master tab normally shows a **Manifest ID** only when the manifest carries a nickname — the line-haul
loads the planners build and name. An order can also sit on an **unnamed** manifest, typically one
dispatched to an outside carrier, and those used to show nothing at all.

On the inbound sheet the ID is now shown for those too (`showUnnamedManifestId` on `INBOUND_CONFIG`).
The nickname stays empty, and that is what keeps these orders **off the lane tabs and out of the
Summary** — both group by nickname. They appear on the master tab only.

Only the master tab gets the flag; lane tabs are grouped by nickname, so such an order can never reach
one, and passing it there would be misleading rather than merely redundant.

Once one of those un-nicknamed manifests reaches **`moving`**, its orders come off the master tab
(`hideMovingUnnamedManifests`). The load is on an outside carrier's truck and there is nothing left to
plan; it is removed rather than relocated. The filter is applied to the master records alone — the lane
tabs and Summary build from their own lists further down, so neither can be disturbed by it.

**Nicknamed manifests are deliberately exempt.** Every line-haul manifest on the inbound sheet is
normally `moving` too — 67 of 76 order rows at the time this was added — so extending the rule to them
would empty the tab rather than tidy it. Their flow is unchanged.

Manifest lifecycle, for reference: `planning` → `assigned` → `moving` → `completed` → `bill-approved`.
The API also defines `dispatched`, which this org never uses.

Nothing extra is fetched: the manifest was already resolved per order for tab routing and links, then
discarded at display time. Outbound keeps the original behaviour.

#### Pricing a lane before it has a driver (outbound)

**Type** is normally derived from the assigned driver. On the outbound Summary a planner may also *type*
`OO` (or `CD`) into it on a lane that has **no driver yet**, and the OO Rev / OO RPM figures compute from
it — what the run would pay an owner-operator, before committing it. Case is normalised, so `oo` works;
anything other than OO/CD is ignored.

Two rules make it behave the way the planners asked:

- **Assigning a driver erases it.** The derived type takes over the moment a driver appears, whether they
  are an owner-operator or a company driver. A typed value never overrides a real one.
- **The totals row ignores it.** OO Rev totals with `SUMIF(Driver,"<>",…)` rather than a plain `SUM`, so an
  assumption shows its own math while the bottom line stays a statement of what is actually committed.

The entry is the planner's own, so it is read back and re-emitted every refresh — keyed by Manifest ID,
exactly like Notes and Actual. Without that it lasted about five minutes: the Summary is rewritten from
scratch on every run, and the derived-from-driver value (blank, with no driver) went straight over it.

Outbound only — inbound still derives Type from the driver alone.

A company driver's OO cells stay blank rather than showing zero, so the totals reflect only the drivers
the cut actually applies to.

### Colors — conditional formatting

**US Outbound is the single source of truth for color rules.** Set conditional formatting there in the
Google Sheets UI (Format → Conditional formatting) and each sync mirrors those rules onto **every
nickname tab** — including newly created ones, which would otherwise start with no rules.

- Colors are owned by you in the spreadsheet; changing one is a click, never a code change.
- Rules are content-based, so they never drift onto the wrong row when data shifts.
- Ranges are remapped **by header name**, not by position — the master has no Miles/RPM but does have
  Nickname, so a rule on **Customs** (col H on the master) correctly lands on col J on a subset tab.
  `$col` references inside custom formulas are remapped the same way.
- A rule covering a column that doesn't exist on the subset tabs (e.g. **Nickname**) is dropped there.
- Rules set **directly on a nickname tab are replaced** each sync — always edit them on US Outbound.

### Alternating colors (banding)

Google's **Format → Alternating colors** is a _banded range_ — a different mechanism from conditional
formatting, so it does not ride along with the rules above. It's handled separately:

- Set alternating colors on **US Outbound**; those colors are the template.
- Each sync re-creates the band on **US Outbound and every nickname tab**, sized to **exactly the rows
  that hold data** (header → last order → totals row). The stripes stop at the last populated row —
  they never run on into the empty rows below.
- Row counts change every run, so the band is resized each sync. A range set once by hand in the UI
  would stripe empty rows as soon as the data shrank.
- A tab with **no data** gets no stripes at all.

### Column widths

Widths are **seeded only when a tab is first created**, then left alone — so a manual resize survives
every sync. **US Outbound** and **Summary** are never rebuilt, so resizing them directly just sticks.

Nickname tabs are **volatile**: rename a manifest (`GA - 07/17*` → `GA - 07/17`) and the old tab is
deleted and rebuilt carrying only the code defaults. So each run:

1. **Before** anything is written, the sync **captures the column widths of the first nickname tab**
   (the tab right after **Summary**) as they exist at that moment — the pre-sync state.
2. **After** the tabs are written, it **re-applies those widths to every nickname tab**.

Reading the widths afterwards would be too late — by then a renamed manifest has already rebuilt the
tab with defaults, which is exactly what used to reset them.

- Resize columns on the **first nickname tab** and **every nickname tab matches it** from the next
  sync on — including tabs created later.
- A tab rebuilt by a rename **gets its widths back** instead of keeping the defaults.
- If there is no nickname tab yet (first ever run), nothing is applied — the defaults stay put.
- Only the table's own columns are touched, and a width that already matches isn't rewritten.

Every outbound run does a **full refresh** — each tab is cleared and rewritten, tabs are reordered,
and any other tabs are removed — so the sheet is always a clean live mirror with **no duplicates**.

## Force Deliver (ops sheet)

Tab: **Force Deliver**

| Order ID   | Status    | Processed at | Info | Error |
| ---------- | --------- | ------------ | ---- | ----- |
| CEL-VIL-45 | pending ▾ |              |      |       |

**How to use**

1. Open the **ops** spreadsheet (`GOOGLE_OPS_SHEET_ID`).
2. On the **Force Deliver** tab, enter the RoseRocket order number in **Order ID** (e.g. `CEL-VIL-45` or `CET-GAT-386`).
3. Choose **Status** from the dropdown: `pending` (process on next sync) or `retry` (re-run a failed row). Leave blank to skip.
4. Every sync run will look up the order, call `mark_delivered` on `platform.roserocket.com`, and write **Status** (`done` or `error`), **Processed at**, **Info** (success details), and **Error** (failures only).

Orders in **Pending dispatch** are auto-booked first, then marked delivered. **Booked** / **In Transit** orders go straight to delivered (for stuck PRB/PP legs).

Force Deliver auto-routes by order-ID prefix (RoseRocket tokens are org-scoped):

| Prefix  | Org env var                      | Example                              |
| ------- | -------------------------------- | ------------------------------------ |
| `CEL-*` | `ROSEROCKET_CELOGISTICS_ORG_URL` | `https://celogistics.roserocket.com` |
| `CET-*` | `ROSEROCKET_ORG_URL`             | `https://cetrucking.roserocket.com`  |

To retry a failed row, set **Status** back to `pending`.

```bash
npm run force-deliver
```

## Force Cancel (ops sheet)

Tab: **Force Cancel**

| Order ID    | Status    | Processed at | Info | Error |
| ----------- | --------- | ------------ | ---- | ----- |
| CET-CEL1-10 | pending ▾ |              |      |       |

Cancels an order that the RoseRocket UI **refuses to cancel**. A multi-stop order's cancel button fails
with `cannot operate on stop via the multi-stop order API. Use the child_orders API`; the platform cancel
endpoint has no such restriction — RoseRocket documents it as cancelling "a single order or **consolidated**
order" — so queueing the order here does what the screen cannot.

Usage matches Force Deliver: enter the **Order ID**, set **Status** to `pending`, and the next ops run
writes back `done`/`error` with details. Org routing is the same (`CEL-*` → CE Logistics, `CET-*` → CE
Trucking). An order already cancelled reports `done` / `Already cancelled` rather than erroring.

> **This is permanent — there is no undo.** Treat it like Force Delete Manifest. A blank Status counts as
> `pending`, so anything typed into the Order ID column is cancelled on the next run.

```bash
npm run force-cancel
```

### Which ID to enter for a multi-stop order

**Enter a stop's Order ID (`CET-CEL1-10`), never the consolidated number (`CELM21756`).**

A multi-stop order in RoseRocket is a *consolidated* order: the parent holds the stops, and each stop is
its own order carrying `consolidated_order_id`. Two things follow:

- Cancel refuses to act on a stop — `cannot operate on stop via the orders API` — so the queue detects
  `consolidated_order_id` and cancels the **parent** instead. **That cancels every stop on it**, which the
  Info column states explicitly. There is no per-stop cancel in the API.
- The parent's own number is **not searchable**. RoseRocket indexes the stops, not the consolidated
  order, so entering `CELM21756` returns "not found" no matter what. Enter a stop and the escalation
  reaches the parent by itself.

Queueing two stops of the same parent is fine — the first cancels it, the second reports
`Already cancelled via consolidated order …` rather than firing a redundant call.

### Multi-stop orders and the "Order not found" trap

RoseRocket does **not** return a multi-stop order from `/api/v1/orders` — not from `search_term`, and not
from a full scan of the order window either. The order is plainly visible on the order screen and in the
Legs module, so a queue row for one used to come back `Order not found` as though the ID were mistyped.

The lookup therefore falls back to the **Legs** module (`/api/v1/trips`), where each leg row embeds its
parent order — id, full_id, state and customer `location_id`, everything the queues need. This applies to
Force Deliver and Force Cancel alike, so both now work on multi-stop orders.

## Force Delete Manifest (ops sheet)

Tab: **Force Delete Manifest**

| Manifest ID | Status    | Processed at | Info | Error |
| ----------- | --------- | ------------ | ---- | ----- |
| CETM25631   | pending ▾ |              |      |       |

**How to use**

1. Open the **ops** spreadsheet (`GOOGLE_OPS_SHEET_ID`).
2. On the **Force Delete Manifest** tab, enter the RoseRocket manifest number in **Manifest ID** (e.g. `CETM25631` or `CELM12345`).
3. Choose **Status** from the dropdown: `pending` (process on next sync) or `retry` (re-run a failed row). Leave blank to skip.
4. Every sync run will look up the manifest, delete any linked **eManifest** records (ACE/ACI), then delete the manifest. Results are written to **Status**, **Processed at**, **Info** (success details), and **Error** (failures only).

Use this for empty or stuck manifests that RoseRocket UI won't delete (e.g. foreign-key errors on `emanifests`). **This is permanent** — there is no undo.

> ⚠️ **Cancel the orders BEFORE deleting the manifest, never after.** A manifest tendered to another org
> (e.g. `CELM21756` from CE Logistics into CE Trucking) is the **tender** behind the receiving org's
> consolidated order. Delete the manifest first and that order is left pointing at a tender that no longer
> resolves: its own `cancel` then fails with `Tender not found`, its stops stay `dispatched`, and **no API
> route can clean it up** — the only cancel endpoint refuses a stop (`cannot operate on stop via the
> orders API`) and refuses the parent (`Tender not found`). At that point it is a RoseRocket support
> ticket. Deleting the manifest is safe once the orders on it are already cancelled.

Org routing matches Force Deliver:

| Prefix  | Org env var                      | Example                              |
| ------- | -------------------------------- | ------------------------------------ |
| `CELM*` | `ROSEROCKET_CELOGISTICS_ORG_URL` | `https://celogistics.roserocket.com` |
| `CETM*` | `ROSEROCKET_ORG_URL`             | `https://cetrucking.roserocket.com`  |

Manifests with active legs/orders or submitted eManifest filings may still fail — check **Error** after the run. Successful deletes show details in **Info** only.

```bash
npm run force-delete-manifest
```

## JO Report (commission sheet)

Tabs on the **commission** spreadsheet (`GOOGLE_COMMISSION_SHEET_ID`), left to right:

| Tab             | Scope                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Lookup**      | User-set date range + commission filter (lookup period). `Refresh lookup` ON/OFF controls whether this tab is rewritten on sync |
| **All Cur**     | Invoice-sent CEL-\* orders **delivered in the current calendar month**                                                         |
| **Roger Cur**   | Same, where On commission = Roger Gratton                                                                                      |
| **Irena Cur**   | Same, where On commission = Irena Pana                                                                                         |
| **Larry Cur**   | Same, where On commission = Larry Persons                                                                                      |
| **Debbie Cur**  | Same, where On commission = Debbie Collins                                                                                     |
| **House Cur**   | Same, where On commission is blank or another name                                                                             |
| **All Pre**     | All invoice-sent CEL-\* orders **delivered in the previous calendar month**                                                    |
| **Roger Pre**   | Orders **delivered in the previous calendar month**, On commission = Roger Gratton                                             |
| **Irena Pre**   | Same for Irena Pana                                                                                                            |
| **Larry Pre**   | Same for Larry Persons                                                                                                        |
| **Debbie Pre**  | Same for Debbie Collins                                                                                                        |
| **House Pre**   | Previous month, where On commission is blank or another name                                                                   |

Tabs still carrying the older long names (`All Commission Current`, `Roger Gratton Current`, …) are
renamed in place on the next sync by `LEGACY_TAB_RENAMES`, so their contents and formatting survive.

Tab order is fixed in `COMMISSION_SHEET_TAB_ORDER` in [`src/invoice-sent-report.js`](src/invoice-sent-report.js).

Refreshed every sync. One row per **order** for **`CEL-*`** orders in RoseRocket status **invoice-sent**
(CE Logistics only, via `ROSEROCKET_CELOGISTICS_ORG_URL`), within the `ROSEROCKET_SINCE_DAYS` window.
Only orders whose **Actual Delivered Date** is in the **current calendar month** appear on **All Cur**, the **\* Cur** rep tabs, and **House Cur**
(e.g. June only while it is June). **All Pre**, the **\* Pre** rep tabs, and **House Pre** show the **previous calendar month** only (e.g. May while it is June).
Rows with no delivery date or a month outside the tab’s window are excluded.

Columns: Customer (`location_name`, e.g. Green Theory Design), Order ID (linked to RoseRocket — e.g.
`CEL-GTD1-116`), Order Status, On commission, Total Revenue without Tax, Currency,
Converted into CAD, Accessorials, Accessorial Total (sum of accessorial line items),
Fuel (surcharge), Total Carrier Cost (estimated until actual is entered in RoseRocket), Margin $
(revenue − carrier cost), Margin %, Partner Carrier by leg, Actual Delivered Date,
Dispatcher, CSR.

**Currency conversion is RoseRocket's, not ours.** Total Revenue, Converted into CAD, Total Carrier
Cost and Margin are read straight off RoseRocket, which converts USD using its own **Exchange Rates**
table (Settings → Accounting → Exchange rates). So every figure here ties out exactly to the numbers
on the RoseRocket order screen. That table is kept current by the
[exchange-rate cron](#exchange-rates-roserocket). Revenue is the order-level quote
(`sub_total_cost` / `fx_sub_total_cost`); carrier cost is the sum of the legs, which RoseRocket
already stores in CAD — a USD manifest's leg cost is the converted CAD amount, not native USD.

**On commission** is populated from RoseRocket's order **commissionees** API (not account manager).

```bash
npm run invoice-sent
```

## Trip history (completed-trip archive)

Spreadsheet: `GOOGLE_TRIP_HISTORY_SHEET_ID`. Tabs: **O/B**, **I/B**, **Rounder**, **By Driver**, **Compare**.

A permanent archive of **finished** round trips — one row per manifest per tab, added once and then frozen.
Unlike the outbound/inbound sheets (live mirrors that rewrite themselves every run), rows here are read
back and re-emitted unchanged, so a manual correction to **Miles** or **Notes** sticks forever and RPM,
being a live formula, follows it.

| Tab         | Shows                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| **O/B**     | The outbound leg: end city (last US drop), its footage/weight, revenue, miles and RPM     |
| **I/B**     | The inbound leg: start city (first US pickup), its footage/weight, revenue, miles and RPM |
| **Rounder** | The whole round trip: revenue, miles and RPM                                              |
| **By Driver** | Per-driver roll-up of the three tabs above — one row per driver per leg                  |
| **Compare** | Two date ranges side by side, per driver, for a chosen leg                                 |

Each tab is a native Google **Table**, so every column filters and sorts, and the totals row uses
`SUBTOTAL` — filter to one driver and the totals become that driver's. Row 1 holds the editable **OO Cut**
percentage; **OO Rev** / **OO RPM** are filled in only for owner-operators (**Type** = `OO`), read from
RoseRocket's driver records.

### The By Driver tab

Rebuilt from scratch on every run: one row per driver per leg (`O/B`, `I/B`, `Rounder`) with Trips,
Revenue, OO Rev, Miles, RPM and OO RPM. Filter **Leg** to get a clean one-row-per-driver view.

It exists because Google Sheets' native **group-by view cannot show a weighted rate**. Its aggregation
menu offers only Sum / Average / Count / Min / Max / Percent filled / …, so a grouped RPM line is the
*average of each trip's RPM*, not total revenue ÷ total miles — and those differ whenever the trips differ
in length. This tab divides the totals instead.

Every figure is a live `COUNTIF`/`SUMIF` over the source tab, never a stored value, so a manual **Miles**
correction or a change to a tab's **OO Cut** flows through here on the next recalculation without a
re-sync. The `SUBTOTAL` totals row is only meaningful with **Leg** filtered — unfiltered it spans all three
legs, and Rounder already covers O/B + I/B, so the grand total double-counts by design.

The group-by views themselves are **not reachable from the API** — the Sheets `Table` object exposes only
`name`, `range`, `columnProperties` and `rowsProperties`, and `FilterView` has no group-by field at all.
Their per-column summary settings are UI-only state and have to be set by hand once; the sync uses
`updateTable` on the existing table ID rather than recreating it, so they survive every run.

### Dates

Each trip tab carries a real **Date** — the manifest's last-stop completion — alongside the `Week N`
label. It sits immediately before **Notes** on purpose: the client's group-by views are pinned to column
POSITIONS that the API cannot read back, so inserting the column any earlier would silently repoint his
filters onto the wrong columns.

The date is what makes month-by-month and year-over-year analysis possible. `Week N` cannot do either —
it carries no year and no month, and sorting on it alone interleaves years the moment the archive crosses
a January (week 1 of 2027 sorting above week 52 of 2026).

Rows archived before the column existed are filled by a one-off backfill:

```bash
npm run trip-history:dates                 # back to TRIP_HISTORY_DATES_FROM (default 2025-11-01)
npm run trip-history:dates -- 2026-01-01   # or from a given date
npm run trip-history:dates -- --overwrite  # also REPLACE dates already on the sheet
```

Without `--overwrite` it only ever fills a **blank** Date, so hand-corrections survive a re-run.

The date comes from RoseRocket's `lkl_completed_at` — when the manifest's last stop actually completed —
**not** `completed_at`, which is the administrative close-out. CET closes manifests in batches, so several
trips that finished on different days share one close-out timestamp; using it put ~14% of trips in the
wrong ISO week, contradicting the `Week N` label already on the sheet. `lkl_completed_at` brings that
disagreement down to ~1%, and the remainder are genuine week-boundary cases where the inbound order
closed the evening before the manifest's last stop did.

### The Compare tab

Two date ranges side by side, per driver, for one leg — the tab that answers "weeks 1–4 vs weeks 5–9",
"June vs July", or "2026 vs 2027".

| Cell     | Picker                                     |
| -------- | ------------------------------------------ |
| **B1**   | Leg — dropdown: `O/B`, `I/B`, `Rounder`    |
| **B2/C2**| Period A, from / to                        |
| **B3/C3**| Period B, from / to                        |

Each driver row shows Trips, Revenue, OO Rev, Miles, RPM and OO RPM for both periods, then Δ Revenue,
Δ Miles and Δ RPM. Δ RPM is deliberately blank unless **both** periods ran miles — Sheets coerces the
empty string an unused period leaves behind to `0`, which would otherwise report a driver's absence as a
full-rate swing. The totals row derives its Δ RPM from the SUBTOTAL sums rather than by adding up the
per-driver deltas, which would weight every driver equally regardless of miles.

Every figure resolves against all three tabs and is picked with `SWITCH` on the Leg cell — deliberately
not `INDIRECT`, because real references break loudly on a tab rename and can be traced with Sheets' own
dependency tools, where a string-built range fails silently.

The pickers live above the header row, and `writeToSheet` clears only from the header row down, so they
survive every sync untouched. They are seeded once, on creation (last full month vs the current month).

### Downloading the sheet as Excel

`File → Download → Microsoft Excel (.xlsx)` in Google Sheets produces a working workbook, and that is the
simplest way to get this data into Excel — no export script, no Drive, no API, no permissions to manage.

Keeping it that way is a constraint on what the sheet is allowed to contain: **every formula written to
these tabs must be one Excel understands.** One slip already cost a round trip — the Compare tab used
`SWITCH`, which postdates Excel 2007, so Google writes it into the .xlsx as `_xlfn.SWITCH` and older Excel
cannot resolve it. Every Compare cell arrived as `#NAME?`, and the Δ columns inherited the error from the
cells they subtract. It is now nested `IF`, which every version understands.

An audit of the whole sheet found `SWITCH` was the only offender: `IF`, `IFERROR`, `SUM`, `SUMIF(S)`,
`COUNTIF(S)`, `SUBTOTAL`, `HYPERLINK`, `OR` are all safe. Before adding a formula here, check it against
Excel 2016 — anything newer needs the same treatment.

Open-ended ranges (`$D$3:$D`) are fine: they are invalid *typed into* Excel, but Google bounds them on
export. By Driver alone carries 552 of them and converts cleanly.

**What still cannot cross over:** the group-by views and filter views. Those are Sheets-only constructs —
not even visible to the Sheets API — and the Excel equivalent is a PivotTable the reader builds themselves.

Each download is an independent snapshot: edits made in one downloaded file do not carry into the next.

### Which trips get archived

A manifest is archived when it is **finished**, and it qualifies **either** way — neither requires a
nickname, and un-nicknamed manifests are archived just like named ones:

1. **By geography (no tagging needed).** The manifest carries a **US → Canada** order whose inbound leg
   has finished. This is how every trip on the sheet got there; it needs nothing from the planners.
2. **By tag (the manual override).** The manifest carries **`US O/B`** or **`US I/B`** and RoseRocket
   reports the manifest itself as finished (completed / bill-created / bill-approved). Tag a manifest and
   it is archived whatever its shape — even if its orders have aged out of the order window.

"Finished" means the inbound haul is done: the pickup leg **unloaded at the terminal** (`UT`), **or** —
for a direct full-load run that never passes through the yard — that leg was **delivered**. The **Completed**
week comes from that date (from the manifest's own completion date for a tag-only match).

### How a trip is split into outbound and inbound

Every trip is cut at **the turn** — the last **US** delivery before the last pickup, i.e. where the truck
drops its outbound freight and goes empty. Miles before the turn are outbound, miles after it are inbound,
and the two add up to the Rounder total. This handles all the shapes in use:

| Trip shape                                                       | O/B      | I/B      |
| ---------------------------------------------------------------- | -------- | -------- |
| Yard run — terminal → US drops → US pickups → terminal            | ✅       | ✅       |
| Full load — CA pickup → US drop → US pickup → CA drop             | ✅       | ✅       |
| Full load where the drop and reload are **one** stop (`exchange`) | ✅       | ✅       |
| One-way **CA → US**                                              | ✅       | — (none) |
| One-way **US → CA**                                              | — (none) | ✅       |
| Deadhead down — terminal → US pickups → terminal                  | — (none) | ✅       |

A trip only appears on a tab whose leg it actually has, so no row is padded with blank mileage.

### Schedule and backfill

The `roserocket-trip-history` cron runs twice an hour (`:13` and `:43`) over a **60-day** window
(`TRIP_HISTORY_SINCE_DAYS`) — enough to catch trips as they finish. Already-archived manifests are
skipped before any of the expensive per-manifest work, so each trip is resolved once, ever.

To fill the sheet further back than the cron reaches, run the **one-off backfill**:

```bash
npm run trip-history:backfill                 # back to TRIP_HISTORY_BACKFILL_FROM (default 2026-01-01)
npm run trip-history:backfill -- 2026-03-01   # back to a given date
npm run trip-history:backfill -- 180          # or a number of days
```

It runs the same archive logic over a much wider window. It is deliberately **not** scheduled: reaching
back to January means paging every order created since then (~8,700) and resolving several hundred
manifests — far too much to repeat every half hour. It writes in batches as it goes and skips anything
already on the sheet, so it is safe to stop and re-run; a second run resumes rather than duplicating.
It writes **only to the spreadsheet** — nothing is sent back to RoseRocket.

```bash
npm run sync:trip-history     # the normal 60-day run
```

### Repairing hollow rows

Every figure on a trip except the manifest's own mileage is derived from its RoseRocket **stops**. If a
run archives a manifest while those fetches are failing, the row lands with a Manifest ID, a week and
almost nothing else — and because an archived manifest is never revisited, that hollow row would block
the real one forever. `resolveManifest` now refuses to archive a trip whose stops came back empty, but
for rows written before that guard existed:

```bash
npm run trip-history:repair            # dry run — lists what it would remove
npm run trip-history:repair -- --apply # remove them
```

It deletes only rows that have a Manifest ID but **no City and no Revenue**, then the next sync or
backfill archives those trips properly.

> The underlying cause was authentication. RoseRocket access tokens live **30 minutes**, not the ~24 h
> this project once assumed, and the API client baked its token in at construction — so any job that ran
> longer than the token (the backfill, a slow commission sync) spent the rest of its life sending a dead
> token. Every call 401'd, and since this codebase deliberately fails open (`fetchMasterTripStops`
> returns `[]`, `resolveOrdersForHistory` returns `null`), the damage was invisible. The client now
> resolves the token per request and re-logs in once on a 401, so a refresh anywhere in the process is
> picked up immediately.

## Exchange rates (RoseRocket)

RoseRocket converts USD to CAD using the **Exchange Rates** table in its own settings
(Settings → Accounting → Exchange rates). Every CAD figure on an order — and therefore every CAD
figure on the commission sheet — comes from that table, so it has to be populated **before** the
orders it prices are quoted.

The table is weekly, **Saturday → Friday**, and each week is priced at the **Bank of Canada
USD→CAD (`FXUSDCAD`) close of the Friday immediately before the week opens**. This rule was
reverse-engineered from the manually maintained CE Logistics rows and matched all eight weeks
checked, exactly. The `roserocket-exchange-rate` cron runs Saturdays at 12:00 UTC (≈08:00 ET) and
creates that week's row automatically. Bank of Canada publishes the Friday close around 16:30 ET
Friday, so the rate is always available by then.

Behaviour:

- **Never overwrites.** If the week already has a rate — typically entered by hand — it is left
  alone. When it differs from the Bank of Canada value, the difference is logged as a warning.
  RoseRocket also refuses overlapping ranges itself, as a second safety net.
- **No backfill.** Only the week containing the run date is created; past gaps are left as they are.
  Backfilling would not help anyway (see below).
- **Not retroactive.** RoseRocket snapshots the rate when a quote or bill is created and does not
  recompute it later. Adding a rate for a past week does **not** change already-priced orders, so
  those keep whatever rate applied when they were created.
- **CE Logistics only** (`ROSEROCKET_CELOGISTICS_ORG_URL`) — the org the commission report reads.

Rates live on the platform host (`https://platform.roserocket.com/api/v1/exchange_rates`), not the
network host used elsewhere. Implementation: [`src/exchange-rates.js`](src/exchange-rates.js).

```bash
npm run sync:exchange-rates
```

## How it works

Each sync run authenticates, fetches RoseRocket data, and writes Google Sheets. Scope is controlled
by env vars (see below).

**Full sync** (`npm run sync`, default `SYNC_SCOPE=full`):

1. **Authenticate** — logs in via `POST {ORG_URL}/api/v1/sessions` and caches the ~24 h token
   (in-memory + `.token.json` per org subdomain).
2. **Fetch outbound data** — pulls orders from CE Trucking (`ROSEROCKET_ORG_URL`) created within the
   recent date window, paginated newest-first, then filters to US Outbound.
3. **Write outbound tabs** — full refresh of **US Outbound** and tag-filtered subset tabs.
4. **Ops sheet** (if `GOOGLE_OPS_SHEET_ID` is set and ops is included):
   - **Force Deliver** — processes pending queue rows (`CEL-*` + `CET-*`).
   - **Force Cancel** — cancels pending queue rows, including multi-stop orders the UI cannot cancel.
   - **Force Delete Manifest** — deletes pending manifests (`CELM*` + `CETM*`).
5. **Commission sheet** (if `GOOGLE_COMMISSION_SHEET_ID` is set and commission is included):
   - **All Commission Current / Previous** — rebuilds the invoice-sent report (`CEL-*` only, CE Logistics).

Each concern runs on its **own** Render cron, so a slow run of one never blocks another:

**Outbound** (`npm run sync:outbound`, webhook, or `SYNC_SCOPE=outbound`) — main outbound cron; US Outbound
sheet only. On Render, runs every **5 minutes** (`:00`, `:05`, …).

**Inbound** (`npm run sync:inbound` or `SYNC_SCOPE=inbound`) — inbound cron. On Render, runs every
**5 minutes**, offset 2 minutes from outbound (`:02`, `:07`, …).

**Commission** (`npm run sync:commission` or `SYNC_SCOPE=commission`) — commission cron. On Render,
runs every **10 minutes** (`:04`, `:14`, …).

**Ops** (`npm run sync:ops` or `SYNC_SCOPE=ops`) — Force Deliver + Force Delete Manifest queues only. On
Render, runs **hourly at `:08`** (`8 * * * *`).

Exits with code `0` (success) or `1` (failure) — suitable for a cron job.

## Prerequisites

- A **RoseRocket** login (email + password) and an **Org App Key** (client id + secret).
- A **Google Cloud** project with a **service account** + JSON key.
- **Google Sheets** (outbound, inbound, ops, commission) shared with that service account — or just the
  outbound sheet if you skip the inbound/ops/commission features.
- Local dev: **Node 18+**. For Render: a **GitHub** (or GitLab) repo.

## RoseRocket setup

1. In RoseRocket go to **Settings → Org Apps** and create (or open) an app to get the **Org App Key**:
   - `ROSEROCKET_CLIENT_ID` = the key (UUID)
   - `ROSEROCKET_CLIENT_SECRET` = the secret (revealed by the key-icon button)
2. CE Trucking org URL → `ROSEROCKET_ORG_URL` (e.g. `https://cetrucking.roserocket.com`).
3. CE Logistics org URL → `ROSEROCKET_CELOGISTICS_ORG_URL` (e.g. `https://celogistics.roserocket.com`)
   — required for `CEL-*` Force Deliver and JO Report.
4. Use a normal login email/password for `ROSEROCKET_USERNAME` / `ROSEROCKET_PASSWORD`.

## Google setup

1. In the [Google Cloud Console](https://console.cloud.google.com) create or select a project.
2. **Enable APIs:** Google **Sheets API** _and_ Google **Drive API**.
3. **Create a service account** → **Keys → Add key → JSON** → download the file.
4. Create the **outbound** and **ops** Google Sheets (or let the app create the outbound sheet on first run).
5. **Share both sheets** with the service account's email (`client_email` in the JSON, ends in
   `…iam.gserviceaccount.com`) as **Editor**.
6. Copy each **Sheet ID** from the URL
   (`https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`) → `GOOGLE_OUTBOUND_SHEET_ID` and
   `GOOGLE_OPS_SHEET_ID`, `GOOGLE_COMMISSION_SHEET_ID` _(full URLs work too)_.

## Force refresh from the outbound / inbound sheet

A **RoseRocket → Force refresh** menu (and optional toolbar button) can trigger an on-demand sync of
either sheet without waiting for the cron schedule.

### 1. Deploy the webhook service (Render)

The [`render.yaml`](render.yaml) blueprint deploys a **web service** (`roserocket-sheets-webhook`) alongside
the cron jobs. After deploy:

1. Copy the web service URL from the Render dashboard (e.g. `https://roserocket-sheets-webhook.onrender.com`).
2. Set **`SYNC_WEBHOOK_SECRET`** on that service to a long random string (same value you will use in Apps Script).
3. Mount the same Google service-account secret file and RoseRocket env vars as the cron job (the web
   service needs `GOOGLE_OUTBOUND_SHEET_ID` **and** `GOOGLE_INBOUND_SHEET_ID`).

Endpoints (both take header `Authorization: Bearer <SYNC_WEBHOOK_SECRET>`):

| Sheet    | Endpoint             | Apps Script                                                                    |
| -------- | -------------------- | ----------------------------------------------------------------------------- |
| Outbound | `POST /refresh/outbound` | [`OutboundRefresh.gs`](google-apps-script/OutboundRefresh.gs)             |
| Inbound  | `POST /refresh/inbound`  | [`InboundRefresh.gs`](google-apps-script/InboundRefresh.gs)               |

The two refreshes use **separate in-flight locks**, so one sheet's refresh never blocks the other's.

Locally: `npm start` (requires `SYNC_WEBHOOK_SECRET` in `.env`).

### 2. Add Apps Script (client / sheet owner — one-time)

Google authorization is **per user** unless you deploy a **web app**. Have the **client** complete these
steps **on each sheet** — the **outbound** sheet with `OutboundRefresh.gs`, and the **inbound** sheet with
`InboundRefresh.gs` (identical setup; each is bound to its own spreadsheet and posts to its own endpoint):

1. **Extensions → Apps Script** → paste [`google-apps-script/OutboundRefresh.gs`](google-apps-script/OutboundRefresh.gs) (or [`InboundRefresh.gs`](google-apps-script/InboundRefresh.gs) on the inbound sheet) → **Save**.
2. Edit `setupRoseRocketWebhook()` with the Render URL + secret → **Run** → **Advanced → Allow**.
3. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone** (or **Anyone in your organization**)
   - **Deploy** → copy the **Web app URL** (ends with `/exec`).
4. Run **`registerWebAppUrl()`** → paste that URL.
5. Run **`pinRefreshTab()`** → adds a **Force Refresh** tab with a clickable link.

The **Force Refresh** tab link works for **everyone** on the sheet — no extra Google authorization for teammates.

### 3. For other users (you, planners, etc.)

- **Easiest:** open the **Force Refresh** tab → click **Force refresh outbound sheet**.
- **Or:** **RoseRocket → Force refresh** menu (may ask you to Allow once — lighter than the old script).
- **Or:** bookmark the web app URL the client shared.

> **Why your client’s setup didn’t fix it for you:** their Allow only applies to **their** Google account.
> The web app runs the refresh **as them**, so you don’t need their permissions or UrlFetch access.

### 4. Optional toolbar button

**Insert → Drawing** → assign script `forceRefresh` (opens the web app in a new tab).

The refresh updates **outbound tabs only**. Ops (Force Deliver) runs on its own ops cron;
commission runs on the commission cron (see `SYNC_SCOPE` below).
The **Force Refresh** tab is kept across syncs (not deleted with regional tabs).

## Environment variables

| Variable                                   |      Required      | Description                                                                                                                                      |
| ------------------------------------------ | :----------------: | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ROSEROCKET_ORG_URL`                       |         ✅         | CE Trucking org URL — outbound sync + `CET-*` Force Deliver                                                                                      |
| `ROSEROCKET_CELOGISTICS_ORG_URL`           |         —          | CE Logistics org URL — `CEL-*` Force Deliver + JO Report                                                                                         |
| `ROSEROCKET_CLIENT_ID`                     |         ✅         | Org App Key UUID                                                                                                                                 |
| `ROSEROCKET_CLIENT_SECRET`                 |         ✅         | Org App secret                                                                                                                                   |
| `ROSEROCKET_USERNAME`                      |         ✅         | RoseRocket login email                                                                                                                           |
| `ROSEROCKET_PASSWORD`                      |         ✅         | RoseRocket login password                                                                                                                        |
| `GOOGLE_OUTBOUND_SHEET_ID`                 |         ✅         | Outbound spreadsheet ID or URL                                                                                                                   |
| `GOOGLE_INBOUND_SHEET_ID`                  |         —          | Inbound spreadsheet ID or URL (US Inbound; `SYNC_SCOPE=inbound`)                                                                                 |
| `GOOGLE_OPS_SHEET_ID`                      |         —          | Ops spreadsheet ID or URL (Force Deliver + Force Delete Manifest)                                                                                |
| `GOOGLE_COMMISSION_SHEET_ID`               |         —          | Commission spreadsheet ID or URL (JO Report)                                                                                                     |
| `GOOGLE_TRIP_HISTORY_SHEET_ID`             |         —          | Trip-history spreadsheet ID or URL (completed-trip archive)                                                                                      |
| `TRIP_HISTORY_SINCE_DAYS`                  |         —          | How far back the trip-history cron looks for finished trips. Default `60`                                                                        |
| `TRIP_HISTORY_BACKFILL_FROM`               |         —          | Default start for `npm run trip-history:backfill`. Default `2026-01-01`                                                                          |
| `TRIP_HISTORY_DATES_FROM`                  |         —          | Default start for `npm run trip-history:dates`. Default `2025-11-01`                                                                             |
| `INBOUND_TRIGGER_TAG`                      |         —          | Nickname-tab trigger tag on the inbound sheet; also archives a manifest to trip history. Default `US I/B`                                        |
| `SYNC_AUTO_TAG_INBOUND`                    |         —          | Set `false` to stop the outbound sync adding `US I/B` to a manifest that reaches LDT. Default `true`                                             |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`          | ✅ _(or JSON var)_ | Path to service-account JSON. On Render: `/etc/secrets/google-service-account.json`                                                              |
| `GOOGLE_SERVICE_ACCOUNT_JSON`              | ✅ _(or file var)_ | Full JSON inline — takes priority if set                                                                                                         |
| `ROSEROCKET_SINCE_DAYS`                    |         —          | Pull orders **created** within the last N days. Default `30`                                                                                     |
| `ROSEROCKET_COMMISSION_LOOKUP_BUFFER_DAYS` |         —          | Extra days before Commission Lookup start date when fetching CEL orders. Default `21`. Lower = faster ops sync; raise if lookup rows are missing |
| `SYNC_SCOPE`                               |         —          | `full`, `outbound`, `inbound`, `ops`, or `commission`. Render crons are staggered so no two share a minute — see [Schedule](#schedule-utc) |
| `SYNC_INCLUDE_OPS`                         |         —          | When scope includes ops, set `false` to skip Force Deliver. Default `true`                                                                       |
| `SYNC_INCLUDE_COMMISSION`                  |         —          | When scope includes commission, set `false` to skip JO Report. Default `true`                                                                    |
| `SYNC_INCLUDE_FORCE_DELIVER`               |         —          | When ops runs, set `false` to skip Force Deliver. Default `true`                                                                                 |
| `SYNC_INCLUDE_FORCE_CANCEL`                |         —          | When ops runs, set `false` to skip Force Cancel. Default `true`                                                                                  |
| `SYNC_INCLUDE_FORCE_DELETE_MANIFEST`       |         —          | When ops runs, set `false` to skip Force Delete Manifest. Default `true`                                                                         |
| `SHEETS_TAB_WRITE_DELAY_MS`                |         —          | Pause between outbound tab writes. Default `2000`                                                                                                |
| `ROSEROCKET_LEG_FETCH_CONCURRENCY`         |         —          | Parallel `/legs` fetches during outbound/inbound. Default `12`                                                                                           |
| `ROSEROCKET_MAX_ORDERS`                    |         —          | Optional hard cap on rows fetched (`0`/unset = unlimited)                                                                                        |
| `ROSEROCKET_BASE_URL`                      |         —          | Data API base. Default `https://network.roserocket.com`                                                                                          |
| `ROSEROCKET_PLATFORM_URL`                  |         —          | Platform API for Force Deliver. Default `https://platform.roserocket.com`                                                                        |
| `ROSEROCKET_TOKEN_URL`                     |         —          | Auth endpoint override. Default `{ORG_URL}/api/v1/sessions`                                                                                      |
| `ROSEROCKET_WEB_URL`                       |         —          | Base URL for US Outbound **Order ID** links. Default = `ROSEROCKET_ORG_URL`                                                                 |
| `SYNC_WEBHOOK_SECRET`                      |         —          | Bearer token for `POST /refresh/outbound` (web service only)                                                                                     |
| `PORT`                                     |         —          | Webhook server port. Default `3000`; Render sets this automatically                                                                              |

See [`.env.example`](.env.example) for a ready-to-copy template.

## Local development

```bash
npm install
cp .env.example .env        # then fill in your values (Windows: copy .env.example .env)
# place your Google key at credentials/google-service-account.json
npm run test-auth           # verify RoseRocket credentials
npm run sync                # full sync (outbound + inbound + Force Deliver + commission)
npm run sync:outbound       # outbound sheet only
npm run sync:inbound        # inbound sheet only
npm run sync:commission     # commission sheet only
npm run sync:ops            # Force Deliver + Force Delete Manifest queues only
npm start                   # webhook server (outbound force refresh from sheet)
npm run force-deliver       # ops Force Deliver queue only
npm run force-cancel        # ops Force Cancel queue only
npm run force-delete-manifest  # ops Force Delete Manifest queue only
npm run invoice-sent        # commission All Commission + rep tabs only
```

## Deploy to Render (Cron Job)

### Option A — Blueprint (recommended)

The repo ships a [`render.yaml`](render.yaml) blueprint.

1. Push this repo to GitHub.
2. In Render: **New → Blueprint** → select the repo.
3. When prompted, paste the **secret** values (`ROSEROCKET_*`, `GOOGLE_OUTBOUND_SHEET_ID`, `GOOGLE_INBOUND_SHEET_ID`,
   `GOOGLE_OPS_SHEET_ID`, `GOOGLE_COMMISSION_SHEET_ID`, `ROSEROCKET_CELOGISTICS_ORG_URL`).
4. Add the Google key as a **Secret File** (see below).
5. **Apply** → Render builds and schedules the job.

### Option B — Manual

1. **New → Cron Job** → connect the repo.
2. **Build command** `npm ci`, **Command** `npm run sync`, **Schedule** e.g. `*/5 * * * *`.
3. Add the environment variables from the table above.
4. Add the Google key as a **Secret File**.

### Google credentials as a Secret File

1. Cron job → **Environment** → **Secret Files** → **Add Secret File**.
2. **Filename:** `google-service-account.json`
3. **Contents:** paste the entire downloaded JSON key.
4. Render mounts it at `/etc/secrets/google-service-account.json` — matches `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` in the blueprint.

> Prefer an env var? Set `GOOGLE_SERVICE_ACCOUNT_JSON` to the full JSON instead.

### Schedule (UTC)

All the sheet-writing crons share **one** Google service account, and Sheets quotas (read/write requests
per minute) are counted **per account** — not per job. So the schedules are deliberately offset: when
outbound, inbound, commission, ops and trip-history all fired on the hour they exhausted the bucket
between them, and the ops run lost its Force Deliver write-back and never read the Force Delete Manifest
queue. **Keep them on different minutes when changing any of these.**

| Job                | Cron              | Runs at            |
| ------------------ | ----------------- | ------------------ |
| Outbound           | `*/5 * * * *`     | `:00, :05, :10, …` |
| Inbound            | `2-59/5 * * * *`  | `:02, :07, :12, …` |
| Commission         | `4-59/10 * * * *` | `:04, :14, :24, …` |
| Ops                | `8 * * * *`       | `:08` hourly       |
| Trip history       | `13,43 * * * *`   | `:13` and `:43`    |
| Exchange rate      | `0 12 * * 6`      | Saturdays 12:00    |

The exchange-rate job writes only to RoseRocket — it makes no Sheets calls — so it is exempt.

Use [crontab.guru](https://crontab.guru). Change in `render.yaml` or the Render dashboard.

### First run

After deploy, **Trigger Run** → watch **Logs**. On success you'll see tab write lines and `[Sync] Complete`.

## Maintenance

### Update RoseRocket credentials

1. Render → cron job → **Environment**.
2. Edit `ROSEROCKET_PASSWORD` (or any credential) → **Save Changes**.
3. The next run picks it up automatically. Locally, delete `.token.json` / `.token.*.json` if needed.

### Change the schedule

Edit `schedule` in the dashboard or `render.yaml` and push.

### Change how much data syncs

Edit `ROSEROCKET_SINCE_DAYS` (default `30`). `ROSEROCKET_MAX_ORDERS` is an optional hard cap.

### Monitor runs

- **Logs** — full output of each run.
- **Events** — run history and exit status.

### Get alerted on failures

Render → **Settings → Notifications** → enable failure notifications.

### Run on demand

Job page → **Trigger Run**, or run `npm run sync` locally.

## Data & behavior details

- **Subset tabs (tag-filtered):** region tabs use exact tag-name match; schedule tabs use substring
  match. Edit `TAG_TABS` in [`src/sync.js`](src/sync.js) to add/rename tabs.
- **Delivery-leg filter:** orders whose final **delivery** leg reaches **LDT** (`loaded_terminal`) or
  **delivered** drop off every outbound tab — one `/legs` call per US Outbound order
  (`HIDE_DELIVERY_LEG_LABELS` in [`src/roserocket.js`](src/roserocket.js)).
- **US Outbound:** destination **US** + status **Booked** (`dispatched`) or **In Transit**
  (`in-transit`). **Order ID** links to RoseRocket via rich-text link.
- **Notes column:** read from **US Outbound** before each refresh and copied to all tabs. Clearing or
  editing a note on US Outbound updates on the next sync; regional tabs mirror the master tab.
- **Outbound full refresh:** live mirror, not an archive. Extra tabs on the outbound sheet are removed.
- **Ops sheet:** sync updates managed queue tabs (**Force Deliver**, **Force Cancel** and **Force Delete Manifest**) without deleting other existing tabs.
- **Token caching:** ~24 h tokens cached per org subdomain (`.token.json`, `.token.celogistics.json`, etc.).

## Troubleshooting

| Symptom                                                 | Cause / fix                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **403 on RoseRocket**                                   | Stale credentials — update env vars; locally delete `.token*.json`. Or login rate limit — wait a few minutes. |
| **New empty spreadsheet each run**                      | `GOOGLE_OUTBOUND_SHEET_ID` not set.                                                                           |
| **`The caller does not have permission`**               | Sheet not shared with service account as **Editor**, or Sheets/Drive APIs disabled.                           |
| **Force Deliver skipped**                               | `GOOGLE_OPS_SHEET_ID` not set.                                                                                |
| **`Order not found` for an order you can see in RoseRocket** | It is a multi-stop order — invisible to the order API. Resolved via the Legs module now; re-run the queue. |
| **UI says `cannot operate on stop via the multi-stop order API`** | Queue the order on the **Force Cancel** tab instead.                                                    |
| **JO Report skipped**                                   | `GOOGLE_COMMISSION_SHEET_ID` not set.                                                                         |
| **CEL orders not in JO Report**                         | `ROSEROCKET_CELOGISTICS_ORG_URL` not set.                                                                     |
| **On commission column empty**                          | Order has no commissionees in RoseRocket (re-run after the commissionees API fix).                            |
| **Outbound tab empty**                                  | No matching records — check logs for fetch/write errors.                                                      |
| **Force refresh asks me to authorize / I can’t run it** | Client must **deploy web app** + run `pinRefreshTab()`. Use the **Force Refresh** tab link (no auth for you). |
| **Render build fails**                                  | Commit `package-lock.json` (needed by `npm ci`); Node ≥ 18.                                                   |
| **`Quota exceeded ... requests per minute per user`**    | Two crons ran in the same minute. Keep the schedules staggered (see [Schedule](#schedule-utc)).               |
| **Ops queue row left blank after a run**                | Its write-back failed (usually quota). Results are retried now; re-run `npm run force-deliver`.               |
| **Trip-history rows with a Manifest ID but no city/revenue** | Their RoseRocket stop fetches failed. Run `npm run trip-history:repair -- --apply`, then re-sync.        |
| **A trip is missing from trip history**                 | It is only archived once **finished**. Tag the manifest `US O/B` / `US I/B` to force it on regardless.        |

## Cost & security

- **Cost:** Render Cron bills only for minutes run. Every-5-minutes ≈ 288 runs/day — dial back `schedule` to reduce cost.
- **Security:** `.env`, `credentials/`, and `.token*.json` are git-ignored. Production secrets live in Render env + Secret Files.
