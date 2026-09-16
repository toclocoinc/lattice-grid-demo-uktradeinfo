# UK goods trade, month by month, from HMRC

A dashboard of what the United Kingdom imports and exports, by commodity
chapter and trading partner, over the last two years, from HM Revenue &
Customs' overseas trade statistics. Built on Lattice Grid loaded by
`<script>` tag: no npm install, no bundler, no build step, no
`type="module"`.

**[See it running](https://toclocoinc.github.io/lattice-grid-demo-uktradeinfo/)**

| | |
| --- | --- |
| Grid on npm | [@toclocoinc/lattice-grid](https://www.npmjs.com/package/@toclocoinc/lattice-grid) |
| Grid repository | [toclocoinc/latticegrid](https://github.com/toclocoinc/latticegrid) |
| Product site | [latticegrid.dev](https://www.latticegrid.dev) |
| Data | [HM Revenue & Customs, uktradeinfo](https://www.uktradeinfo.com/), Open Government Licence v3.0 |

It is one month of trade in a data router with several views on it: a table
of every chapter and partner, a strip of headline figures, four charts, and
tabs for exports and imports. Everything reads the same rows, so grouping,
sorting or filtering the table moves the figures and the charts with it.
Pick another month and that month goes through the router instead; the rows
the two months share are updated in place and only what changed is
repainted.

## What the page reads, and why it is a saved copy

The figures come from the HMRC uktradeinfo API. It is a public OData service
with no key and no login, and a page on this repository's own address cannot
read it: the API answers without an `Access-Control-Allow-Origin` header, so
every browser refuses to hand the response to a page on another web address.
There is no way round that from inside a browser, and this demo does not
pretend otherwise.

So the page never calls the API. `tools/build-snapshot.mjs` calls it under
Node, where the cross-origin rule does not apply, and saves what it fetched
to `data/snapshot/`. The page reads that, and says so in the badge at the top
together with the day the copy was taken. A workflow takes a fresh copy every
night and publishes the page when the copy has changed. HMRC publishes a
month about six weeks after it ends, so most nights nothing changes; the
night after a release the new month appears and the oldest leaves the window.

`tools/verify.mjs` insists on this: it watches every request the page makes
and fails if one goes to the API, then blocks the API in the browser and
insists the page is unchanged.

### The API, as measured

Everything below was established by real requests from Node, not read from
the documentation alone.

- **Shape.** OData 4. The entity sets are `OTS` (overseas trade by month,
  commodity, partner, port and flow), `RTS` (regional trade), `Commodity`,
  `Country`, `Date`, `FlowType`, `Port`, `Region`, `SITC`, and the trader
  sets `Trade`, `Import`, `Export`, `Trader`, `TradeType`, `YearlyTrade`.
  `$metadata` describes them all.
- **Allowed operations.** `$filter`, `$select`, `$expand`, `$top`, `$skip`,
  `$apply`, `$count` and `$format`. Anything else, `$orderby` and the `in`
  operator included, is answered with `403` and a sentence saying to use only
  the allowed operations. `$apply` can group on a navigation property, which
  is what makes one request per month possible.
- **Paging.** Forty thousand rows a page, with an `@odata.nextLink` when
  there are more. A whole month at chapter level is fifteen thousand rows and
  arrives in one page, about two megabytes, in two to four seconds.
- **Rate limit.** Sixty requests a minute. The snapshot tool makes about
  thirty, one a second, and waits a minute and retries if it is refused.
- **Cadence.** A month is published about six weeks after it ends, on a
  [published calendar](https://www.uktradeinfo.com/trade-data/release-calendar/).
  On the day this was written, July 2026 was the newest month with trade in
  it and August was due in mid October.
- **What a row is.** The `OTS` table holds a row per eight-digit commodity
  code, per partner, per port, per flow type, per month. A two-digit
  `CommodityId` is not a chapter total: it is a placeholder for trade
  recorded at chapter level only, worth a small fraction of the chapter.
  Chapter totals have to be added up, and `$apply` grouped on
  `Commodity/Hs2Code` does that on the API's side.
- **Flow types.** Four: EU imports, EU exports, non-EU imports, non-EU
  exports. This demo adds the EU and non-EU halves of each direction back
  together.
- **Licence.** Open Government Licence v3.0.

## The slice

All ninety-seven commodity chapters of the Harmonised System, for the thirty
partner countries with the most trade over the window, for the twenty-four
months to the newest one published, imports and exports: 123,865 rows in
3.4 MB of JSON, about 5,200 rows a month.

Why that shape:

- **Chapters, not eight-digit codes.** A month at eight-digit level is
  several hundred thousand rows, and the table would be a list of codes
  nobody reads. Chapters are the level people talk about: vehicles,
  pharmaceuticals, precious metals.
- **Thirty partners.** They carry 87% of UK goods trade by value; the other
  two hundred and thirty countries share the rest. The month on screen is
  five thousand rows, which the grid draws in a fraction of a second and a
  reader can group and sort without waiting.
- **Twenty-four months.** Enough for a year-on-year comparison at any point,
  and for the trend to show the seasonal shape twice.
- **Both flows on one row set.** Each row is one flow, so the table can be
  grouped by anything and the balance is a sum: exports count for, imports
  against, and the total of that column over any set of rows is the trade
  balance for that set.

What is left out, and said on the page: HMRC's estimates for trade below the
reporting threshold, low-value trade, ships' stores and confidential trade,
which have no partner or no commodity. The totals here are therefore below
the headline figures HMRC publishes.

## What it shows

**The table.** One row per chapter, partner and flow for the month on
screen: the HS section and chapter, the commodities, the partner and its
region, the flow, the value in pounds, the net mass in tonnes, and the
balance contribution. Group by section, chapter, partner or region; sort;
filter any column; search the whole table. The group subtotal of the balance
column is the balance with that partner or in that section, and the grand
total is the balance for everything in view. Balance cells are green in
surplus and red in deficit; that is a conditional formatting rule the grid
holds, and the Formatting panel lets a reader change it.

**Headline figures.** A KPI panel bound to the table
(`createKPI(host, { grid, rowKey, fields, tiles })`), so it reads whatever the
table currently matches and follows it on its own: exports and imports in
view, the balance (banded by its sign), the change on the month before, and
how many partners are in view. The change tile is like for like: it compares
the chapter, partner and flow combinations in view with the same combinations
in the previous month, so narrowing the table to Germany compares Germany
with Germany. The one figure that is not a tile is the largest partner,
which is a phrase with a country in it; it is drawn by hand from the bound
panel's own rows.

**Charts.** Who the trade is with, by partner; what is traded, by HS
section; imports against exports by world region; and the month-by-month
trend across the whole window. The first three are bound to the table. The
trend is bound to a second dataset: a grid with no DOM holding every saved
month, and a derived grid over it that adds the months up by flow, so the
chart draws forty-eight points rather than a hundred thousand rows. The trend
still follows the table, because the window grid is narrowed to the
combinations the table matches.

**Tabs.** Exports and imports each have their own table, derived from the
combined one by the tabs module (`from` and `where`), with a live row count
on the tab before it has ever been opened.

**A month selector.** Choosing a month puts that month's rows through the
router as a keyed diff. The month is also in the address (`?month=2026-03`),
so a view can be linked to.

## How the grid gets onto the page

Six tags in `index.html`, and that is the whole of the library setup:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.62.0/lattice-grid.min.css">

<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.62.0/lattice-grid.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.62.0/modules/charts.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.62.0/modules/data-router.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.62.0/modules/kpi.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.62.0/modules/tabs.min.js"></script>
```

Each file is the package's UMD build and leaves a global behind:

| File | Global | Used here for |
| --- | --- | --- |
| `lattice-grid.min.js` | `LatticeGrid` | `createGrid`, `createHeadlessGrid`, `setLicence` |
| `modules/charts.min.js` | extends `LatticeGrid` | `LatticeGrid.createChart` |
| `modules/data-router.min.js` | `LatticeGridDataRouter` | `createDataRouter` |
| `modules/kpi.min.js` | `LatticeGridKPI` | `createKPI` |
| `modules/tabs.min.js` | `LatticeGridTabs` | `createTabs` |

The charts module folds its exports into the core global rather than defining
one of its own, so its tag must come after the core's. The other three are
self-contained and can go in any order. `main.js` checks that every factory it
needs is actually there before it draws anything, so a tag that did not load
is reported as a sentence rather than as an error from inside the grid.

Every address names the exact release, `1.62.0`, and every tag carries the
`integrity` hash of the file it expects. The page cannot quietly pick up a
different build than the one it was checked against, and the browser refuses
a file that does not match. The hashes are the SHA-384 of the published files.

The demo's own code is four classic scripts, loaded in order after the
library: `src/licence.js`, `src/hmrc-api.js`, `src/dashboard.js`, `main.js`.
Each file wraps itself in a function and puts what it offers on one plain
object, `TradeDemo`, for the next file to read. `src/dashboard.js` is handed
the grid's factories as arguments and never touches a global itself.

## When to choose script tags over the ESM package

The choice is about how the grid reaches the page, and the script-tag route
is the right one when:

- **There is no build.** A page served straight from disk, a CMS template, a
  static site, an internal tool someone maintains by editing one HTML file. A
  `<script src>` is a line of HTML; an `import` needs either a bundler or a
  server that serves the package files and a browser path to them.
- **The host page is not yours.** A widget dropped into a portal, an intranet
  page, a page built by a different team's stack. Script tags coexist with
  whatever else the page loads and ask nothing of its toolchain.
- **The stack has no module pipeline.** Older server-rendered applications,
  jQuery-era front ends, pages built by a back-end framework that emits HTML.
  The UMD build defines a global and gets out of the way, which is what those
  pages already expect of a library.
- **You want the CDN to do the hosting.** Nothing to install, nothing to copy
  into a `vendor` folder, and a pinned version plus an integrity hash gives
  you the same reproducibility a lockfile does.
- **You are evaluating.** Copy `index.html`, open it, and the grid is running.
  There is no quicker way to see whether it does what you need.

Choose the ESM package instead when:

- **You already have a bundler.** Then the ESM build is the natural fit: it
  tree-shakes, the modules that extend the core share the one copy the page
  already imported, and you get TypeScript declarations wired through
  `package.json` with no configuration.
- **You need the eighteen extra chart types.** They ship as ESM only, each
  self-registering onto the charts module. There is no UMD build for them.
- **You want everything offline, including the library.** An ESM edition can
  install the grid into `node_modules` and serve it from there. This edition
  needs to reach jsDelivr for the library even though its data is on disk.
- **You would rather not trust a third-party CDN in production.** A pinned
  version with an integrity hash is safe against a changed file, but not
  against the CDN being down. The ESM package can be served from your own
  origin.

What does not change between the two: the grid's API, the modules, the
licence, the behaviour, the figures.

## Running it

You need nothing but a browser and a way to serve the folder, because the
page fetches its data with `fetch()` and browsers will not do that from
`file://`. Any static server will do; one is included:

```
node tools/serve.mjs
```

That prints an address. Open it.

| Address | What you get |
| --- | --- |
| `/` | the saved copy, opened on the newest month |
| `/?month=2026-03` | the saved copy, opened on March 2026 |
| `/?source=snapshot` | the same as `/`, kept so the address means the same as in the other demos |

Running a copy on your own machine needs no licence key. Publishing it on a
web address does.

The month on screen is on the page in well under a second. The other
twenty-three months are read in behind it for the trend, and the readout
under the title counts them in; on a 2026 laptop that takes about twenty
seconds, almost all of it inside the grid adding each month to the window
(see the last note under "Things worth knowing").

## Files

```
index.html                 page shell, and the six library tags
main.js                    reads the saved copy, then starts
src/licence.js             the key for this demo's own published address
src/hmrc-api.js            the API: queries, shaping, the saved copy's format
src/dashboard.js           the views: router, tables, tiles, charts, tabs
styles.css                 the page around the grid
tools/serve.mjs            a small static file server
tools/build-snapshot.mjs   take a fresh copy from the API into data/snapshot
tools/verify.mjs           open it in a real browser and check it
data/snapshot/meta.json    the months, the partners, the chapter names, the totals
data/snapshot/months/      one file per month, a compact array of rows
.github/workflows/         publish on push; refresh the saved copy nightly
```

There is no `package.json` and no `node_modules`. The tools need Node 22 or
newer and nothing else.

## Checking it

```
node tools/build-snapshot.mjs   # take a fresh copy from the API (about 90 seconds)
node tools/verify.mjs           # open the page in a real browser and assert
node tools/verify.mjs --shots out/   # the same, saving screenshots
```

`tools/verify.mjs` is not a smoke test. It first insists on how the library
arrived: no `type="module"` script anywhere on the page, five script tags
pointing at the pinned release on the CDN, each with an integrity hash, and
each leaving the global it documents. It then recomputes every headline
figure from the saved files in Node and compares it with what the page
shows, to the pound; narrows the table and insists the tiles, the charts and
the trend moved with it and still agree with the recomputation; puts another
month through the router and checks its figures too; groups the table and
insists the rows under the collapsed groups still count; opens the exports
and imports tabs and insists each holds exactly its flow's rows; and watches
every request the page makes, failing if one goes to the API. Finally it
blocks the API in the browser and opens the default page, to prove nothing
changes. The GitHub Pages workflow runs it before every publish.

## Things worth knowing about the data

- Values are in pounds sterling, whole pounds, as HMRC publishes them.
- Net mass is in tonnes here and kilograms at source. Where HMRC withheld it,
  the cell says so rather than showing a zero.
- Monthly figures are revised after first publication. The nightly copy picks
  the revisions up.
- Since 2021, trade with the EU is measured from customs declarations, as
  non-EU trade always was. The two are added together here.
- A partner's region is HMRC's own grouping, from the Country table.
- The window grid that feeds the trend is filled a month at a time through
  the grid's keyed diff. In the 1.62.0 release the cost of that grows with
  the rows the grid already holds, which is why the trend takes longer to
  fill than the table takes to draw. The page says how many months it has
  read so far.

## Licence

The demo code is MIT. See `LICENSE`.

Contains public sector information licensed under the Open Government Licence
v3.0. The trade figures are from HM Revenue & Customs, uktradeinfo.

Lattice Grid itself is a separate commercial product with its own terms. It is
free to use on localhost, with no key and no watermark, so a copy of this
repository runs unrestricted on your own machine. This demo carries a key for
its own published address only, which is why you will find one in the source.
Keys for your own sites come from [latticegrid.dev](https://www.latticegrid.dev).
