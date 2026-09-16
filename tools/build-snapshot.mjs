/**
 * Take a fresh copy of the trade figures from the HMRC uktradeinfo API and
 * save it to `data/snapshot/`, which is the only place the page reads from.
 *
 * Run it with `node tools/build-snapshot.mjs`. It is a development tool and a
 * nightly job; nothing the page loads imports it.
 *
 * Why a saved copy rather than the page calling the API: the API answers
 * without an `Access-Control-Allow-Origin` header, so a browser on any other
 * web address is refused the response. Node has no such rule. The API is
 * rate-limited to sixty requests a minute; this makes about thirty, spaced a
 * second apart, and waits a minute and retries when it is refused.
 *
 * The code that builds the queries and shapes the rows is a classic script
 * the page also runs, so it cannot be imported. It is run here instead, in
 * this process, exactly as the browser runs it: the file leaves its functions
 * on `globalThis.TradeDemo` and they are read from there.
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'data', 'snapshot');
const monthDir = join(outDir, 'months');

const apiFile = join(here, '..', 'src', 'hmrc-api.js');
runInThisContext(await readFile(apiFile, 'utf8'), { filename: apiFile });
const T = globalThis.TradeDemo;

/** A gap between requests: sixty a minute is the limit, so one a second is safe. */
const GAP_MS = 1100;

const started = Date.now();
let requests = 0;

/**
 * One request to the API, with the spacing and the retry the limit calls for.
 *
 * A refused request (the API answers 403 with a sentence about the limit) or
 * a server error is tried again after a pause; a second failure stops the
 * run, and the copy already on disk stays as it was.
 */
async function get(url, label) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    requests += 1;
    const at = Date.now();
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    } catch (error) {
      console.log(`  ${label}: ${error.message}; trying again`);
      await sleep(15000);
      continue;
    }
    const seconds = ((Date.now() - at) / 1000).toFixed(1);
    if (response.ok) {
      const body = await response.json();
      console.log(`  ${label}: ${response.status} in ${seconds}s`);
      await sleep(GAP_MS);
      return body;
    }
    const text = await response.text();
    console.log(`  ${label}: ${response.status} after ${seconds}s: ${text.slice(0, 120)}`);
    if (response.status === 403 || response.status === 429) {
      console.log('  the API refused the request; waiting a minute before trying again');
      await sleep(61000);
    } else if (attempt < 3) {
      await sleep(15000);
    }
  }
  throw new Error(`${label}: the API did not answer after three attempts`);
}

/* ---------------- the lookups ---------------- */

console.log('Reading the country and chapter tables...');
const countryRows = (await get(T.countryQuery(), 'countries')).value;
const chapterRows = (await get(T.chapterQuery(), 'chapters')).value;

const countries = new Map();
for (const c of countryRows) {
  countries.set(c.CountryId, {
    id: c.CountryId,
    name: (c.CountryName || '').trim(),
    code: (c.CountryCodeAlpha || '').trim() || null,
    region: (c.Area1a || '').trim() || 'Unallocated',
  });
}
const chapters = {};
for (const c of chapterRows) {
  if (c.Hs2Code) chapters[c.Hs2Code] = (c.Hs2Description || '').trim();
}
console.log(`  ${countries.size} countries, ${Object.keys(chapters).length} chapters`);

/* ---------------- the newest published month ---------------- */

/*
 * The Date table lists a month once HMRC has published it, about six weeks
 * after the month ends. The newest listed month is checked for at least one
 * row of trade before it is trusted, and the one before it is tried if not.
 */
console.log('Finding the newest published month...');
const thisYear = new Date().getUTCFullYear();
const listed = [];
for (const year of [thisYear, thisYear - 1]) {
  const months = (await get(T.yearQuery(year), `months of ${year}`)).value;
  for (const m of months) listed.push(m.MonthId);
}
listed.sort((a, b) => b - a);
let newestId = null;
for (const id of listed.slice(0, 6)) {
  const probe = (await get(T.monthProbeQuery(id), `probe ${id}`)).value;
  if (probe.length) {
    newestId = id;
    break;
  }
}
if (!newestId) throw new Error('none of the six newest listed months holds any trade');
const newest = T.monthKey(newestId);
const months = T.monthsEndingAt(newest, T.WINDOW_MONTHS);
console.log(`  newest month with trade: ${T.monthLabel(newest)}; window ${months[0]} to ${newest}`);

/* ---------------- the months ---------------- */

console.log(`Reading ${months.length} months, one request each...`);
const foldedByMonth = new Map();
const world = {};
const apiRowCounts = {};
const byCountry = new Map();
for (const month of months) {
  const body = await get(T.monthQuery(T.monthId(month)), month);
  if (body['@odata.nextLink']) {
    throw new Error(`${month}: the answer was paginated, which this tool does not expect for a chapter-level month`);
  }
  const { folded, world: totals } = T.foldMonth(body.value);
  foldedByMonth.set(month, folded);
  world[month] = { imports: Math.round(totals.I), exports: Math.round(totals.X) };
  apiRowCounts[month] = body.value.length;
  for (const row of folded.values()) {
    if (T.NOT_A_COUNTRY.has(row.countryId)) continue;
    byCountry.set(row.countryId, (byCountry.get(row.countryId) || 0) + row.value);
  }
}

/* ---------------- the partners ---------------- */

const partnerIds = [...byCountry.entries()]
  .filter(([id]) => countries.has(id))
  .sort((a, b) => b[1] - a[1])
  .slice(0, T.PARTNER_COUNT)
  .map(([id]) => id);
const partners = partnerIds.map((id) => ({ ...countries.get(id), total: Math.round(byCountry.get(id)) }));
const partnerSet = new Set(partnerIds);
console.log(`  top ${partners.length} partners over the window: ${partners.map((p) => p.name).join(', ')}`);

/* ---------------- write ---------------- */

await rm(monthDir, { recursive: true, force: true });
await mkdir(monthDir, { recursive: true });

let rowsWritten = 0;
const coverage = {};
for (const month of months) {
  const file = T.encodeMonth(month, foldedByMonth.get(month), partnerSet);
  rowsWritten += file.rows.length;
  /* How much of the whole world's trade the kept partners carry, by value. */
  let kept = 0;
  for (const cells of file.rows) kept += cells[3];
  const all = world[month].imports + world[month].exports;
  coverage[month] = { rows: file.rows.length, kept: Math.round(kept), share: all ? Number((kept / all).toFixed(4)) : null };
  await writeFile(join(monthDir, `${month}.json`), JSON.stringify(file));
}

const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
const meta = {
  fetchedAt: new Date().toISOString(),
  fetchedAtMs: Date.now(),
  seconds,
  requests,
  source: 'HM Revenue & Customs, uktradeinfo',
  sourceUrl: 'https://www.uktradeinfo.com/',
  apiUrl: T.API,
  licence: 'Open Government Licence v3.0',
  licenceUrl: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
  months,
  newest,
  rows: rowsWritten,
  partners,
  chapters,
  /* Whole-world totals per month, every partner and bucket included, so the
     page can say how much of UK trade the kept partners account for. */
  world,
  coverage,
  apiRowCounts,
};
await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

const written = await readdir(monthDir);
console.log(`\nSaved ${rowsWritten} rows across ${written.length} months in ${seconds}s, ${requests} requests.`);
console.log(`Newest month ${T.monthLabel(newest)}: ${coverage[newest].rows} rows, the kept partners carry ${(coverage[newest].share * 100).toFixed(1)}% of all UK goods trade by value.`);
