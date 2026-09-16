/**
 * Load the demo in a real browser and check that it works.
 *
 * Serves the project and opens the saved copy, which is the only data the
 * page has. It does depend on jsDelivr, because that is where the page gets
 * the grid from: this edition has no local copy of the library at all, and a
 * check that loaded one would not be checking the page.
 *
 * Beyond "it drew something", it asserts the things this demo exists to show:
 *
 *   - the library arrived by classic script tag: there is no `type="module"`
 *     script on the page, every library tag points at the pinned release on
 *     the CDN, and each one left the global it documents;
 *   - every headline figure agrees with the saved copy, recomputed here from
 *     the saved files rather than read back off the page;
 *   - narrowing the table moves the tiles, the charts and the trend;
 *   - choosing another month puts that month's rows through the router and
 *     the figures follow, and the month-on-month tile compares like for like;
 *   - the exports and imports tabs hold exactly their flow's rows;
 *   - the page never calls the HMRC API, which cannot be read from a browser,
 *     and blocking the API in the browser changes nothing.
 *
 * Exits non-zero when any of that fails, so it can gate a deployment.
 *
 * Usage: node tools/verify.mjs [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { startServer } from './serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const args = process.argv.slice(2);
const shotIndex = args.indexOf('--shots');
const shotDir = shotIndex >= 0 ? resolve(args[shotIndex + 1]) : null;

/** The release every library tag must name, and the globals each file leaves. */
const GRID_VERSION = '1.62.0';
const CDN_BASE = `https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@${GRID_VERSION}/`;
const LIBRARY_TAGS = [
  { file: 'lattice-grid.min.js', global: 'LatticeGrid', member: 'createGrid' },
  { file: 'modules/charts.min.js', global: 'LatticeGrid', member: 'createChart' },
  { file: 'modules/data-router.min.js', global: 'LatticeGridDataRouter', member: 'createDataRouter' },
  { file: 'modules/kpi.min.js', global: 'LatticeGridKPI', member: 'createKPI' },
  { file: 'modules/tabs.min.js', global: 'LatticeGridTabs', member: 'createTabs' },
];

const API_HOST = 'api.uktradeinfo.com';
const BIG_TRADE = 10000000;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

/** The first browser on this machine that actually exists. */
async function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error(`No browser found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH to point at one.`);
}

/**
 * This check talks to the browser over a WebSocket, which Node only provides
 * as a global from version 22. Say so plainly rather than failing later with
 * an unexplained missing name.
 */
function requireModernNode() {
  if (typeof WebSocket === 'undefined') {
    throw new Error(
      `This check needs Node 22 or newer. You are running ${process.version}, which has no built in WebSocket.`,
    );
  }
}

/** A free TCP port, asked of the operating system. */
function freePort() {
  return new Promise((ok, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

const failures = [];
const notes = [];

/** Record a check and its outcome. */
function check(ok, description, detail) {
  if (ok) {
    notes.push(`  ok   ${description}${detail ? ` (${detail})` : ''}`);
  } else {
    failures.push(`${description}${detail ? ` (${detail})` : ''}`);
    notes.push(`  FAIL ${description}${detail ? ` (${detail})` : ''}`);
  }
}

/* ------------------------------------------------------------------ */
/* The independent recomputation, from the saved files, in Node.       */
/* ------------------------------------------------------------------ */

/* The page's own data code is a classic script, so it is run here in this
   process exactly as the browser runs it, and its functions read off the
   global it leaves. One copy of the shaping code, used by both. */
const apiFile = join(root, 'src', 'hmrc-api.js');
runInThisContext(await readFile(apiFile, 'utf8'), { filename: apiFile });
const T = globalThis.TradeDemo;

const meta = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'meta.json'), 'utf8'));
const lookups = { partners: meta.partners, chapters: meta.chapters };
const savedMonth = async (month) =>
  T.decodeMonth(JSON.parse(await readFile(join(root, 'data', 'snapshot', 'months', `${month}.json`), 'utf8')), lookups);

/** The headline figures for a set of rows, as the tiles should show them. */
function figures(rows, previousRows) {
  const previous = new Map((previousRows || []).map((r) => [r.key, r]));
  let exports = 0;
  let imports = 0;
  let now = 0;
  let before = 0;
  let matched = 0;
  const partners = new Map();
  for (const r of rows) {
    if (r.flow === 'Exports') exports += r.value;
    else imports += r.value;
    /* Like for like: only the combinations both months hold, on both sides. */
    const prior = previous.get(r.key);
    if (prior) {
      now += r.value;
      before += prior.value;
      matched += 1;
    }
    partners.set(r.partner, (partners.get(r.partner) || 0) + r.value);
  }
  let top = null;
  for (const [partner, total] of partners) if (!top || total > top.total) top = { partner, total };
  return {
    rows: rows.length,
    exports,
    imports,
    balance: exports - imports,
    change: matched && before ? (now - before) / before : null,
    partners: partners.size,
    top: top ? top.partner : null,
  };
}

/** Two figures agree: exactly for the sums, to a rounding for the ratio. */
function same(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(Number(a) - Number(b)) <= 1e-6 * Math.max(1, Math.abs(Number(b)));
}

const newest = meta.newest;
const previous = T.previousMonth(newest);
const newestRows = await savedMonth(newest);
const previousRows = meta.months.includes(previous) ? await savedMonth(previous) : [];
const expected = figures(newestRows, previousRows);
console.log(`Saved copy: ${meta.months.length} months, newest ${newest} with ${newestRows.length} rows; copy taken ${meta.fetchedAt}`);
console.log(`  expected tiles for ${newest}: ${JSON.stringify(expected)}`);

let browser;
let browserPid = null;
let profile;
let server;

try {
  requireModernNode();
  const chromePath = await findChrome();
  const started = await startServer(0);
  server = started.server;
  const origin = `http://127.0.0.1:${started.port}`;
  console.log(`Browser: ${chromePath}`);
  console.log(`Serving: ${origin}`);

  profile = await mkdtemp(join(tmpdir(), 'trade-umd-demo-verify-'));
  /* A port of the operating system's choosing, so two checks running side by
     side on one machine cannot land on the same debugging socket. */
  const port = await freePort();
  /* Its own process group, so the whole browser tree can be taken down
     together rather than leaving orphaned renderers behind. Only the browser
     this check started is ever signalled. */
  browser = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  browserPid = browser.pid;
  browser.stderr.on('data', () => {});

  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) wsUrl = (await response.json()).webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('the browser never opened its debugging port');

  const socket = new WebSocket(wsUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = () => fail(new Error('could not attach to the browser'));
  });

  let nextId = 0;
  const pending = new Map();
  let consoleErrors = [];
  let pageErrors = [];
  const requested = [];

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id != null && pending.has(message.id)) {
      const { resolve: ok, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else ok(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      pageErrors.push(details.exception?.description || details.text);
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(message.params.entry.text);
    }
    if (message.method === 'Network.requestWillBeSent') {
      requested.push(message.params.request.url);
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((ok, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: ok, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description || ''));
    }
    return result.result.value;
  };

  const waitFor = async (expression, timeout, what) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      let value;
      try {
        value = await evaluate(expression);
      } catch {}
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  /** Open a URL with a clean error log and wait for the dashboard to report in. */
  const open = async (url, label) => {
    consoleErrors = [];
    pageErrors = [];
    console.log(`\n--- ${label} ---\n${url}`);
    await call('Page.navigate', { url });
    await waitFor('!!(window.__tradeDemo)', 120000, `${label} to load`);
    const state = await evaluate('({ ready: window.__tradeDemo.ready, error: window.__tradeDemo.error || null })');
    if (!state.ready) throw new Error(`${label} reported a failure: ${state.error}`);
    await waitFor('window.__tradeDemo.allGrid && window.__tradeDemo.allGrid.rows.count() > 0', 60000, `${label} rows`);
  };

  /** Save a screenshot, when a directory was asked for. */
  const shoot = async (name) => {
    if (!shotDir) return;
    await mkdir(shotDir, { recursive: true });
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    const file = join(shotDir, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`  shot ${file}`);
  };

  /** Complain about anything the page logged. */
  const noErrors = (label) => {
    check(consoleErrors.length === 0, `${label}: no console errors`, consoleErrors.slice(0, 3).join(' | '));
    check(pageErrors.length === 0, `${label}: no page errors`, pageErrors.slice(0, 3).join(' | '));
  };

  /** The tiles, the named reading and the row counts, as the page shows them. */
  const readFigures = () => evaluate(`(() => {
    const d = window.__tradeDemo;
    const tiles = Object.fromEntries(d.kpi.tiles().map((t) => [t.id, t.value]));
    return {
      rows: d.allGrid.rows.count(),
      total: d.allGrid.rows.totalCount(),
      exports: tiles.exports, imports: tiles.imports, balance: tiles.balance, change: tiles.change, partners: tiles.partners,
      balanceStatus: (d.kpi.tile('balance') || {}).status || null,
      named: document.querySelector('.kpi-named-value').textContent,
      selected: d.selected,
      selectValue: d.monthSelect.value,
      trendRows: d.trendRowCount(),
      keysInView: d.keysInView().size,
    };
  })()`);

  /** Every headline figure against the recomputation. */
  const compareFigures = (label, shown, want) => {
    check(shown.rows === want.rows, `${label}: the row count matches the saved copy`, `${shown.rows} against ${want.rows}`);
    check(same(shown.exports, want.exports), `${label}: the exports tile matches the saved copy`, `${shown.exports} against ${want.exports}`);
    check(same(shown.imports, want.imports), `${label}: the imports tile matches the saved copy`, `${shown.imports} against ${want.imports}`);
    check(same(shown.balance, want.balance), `${label}: the balance tile matches the saved copy`, `${shown.balance} against ${want.balance}`);
    check(same(shown.change, want.change), `${label}: the month-on-month tile matches the saved copy, like for like`, `${shown.change} against ${want.change}`);
    check(shown.partners === want.partners, `${label}: the partners tile matches the saved copy`, `${shown.partners} against ${want.partners}`);
    check(
      !!want.top && shown.named.startsWith(`${want.top},`),
      `${label}: the largest partner is named`,
      `"${shown.named}" should name ${want.top}`,
    );
    check(
      shown.balanceStatus === (want.balance >= 0 ? 'good' : 'critical'),
      `${label}: the balance tile is banded by its sign`,
      `${shown.balanceStatus} for ${want.balance}`,
    );
  };

  /* =================================================================== */
  /* 1. The saved copy, cross-checked against the saved files.            */
  /* =================================================================== */

  await open(`${origin}/index.html?source=snapshot`, 'saved copy');

  /* ---- how the library arrived ---- */

  const delivery = await evaluate(`(() => {
    const scripts = [...document.querySelectorAll('script')];
    return {
      moduleScripts: scripts.filter((s) => s.type === 'module').length,
      importmaps: scripts.filter((s) => s.type === 'importmap').length,
      librarySrcs: scripts.map((s) => s.getAttribute('src') || '').filter((src) => /cdn\\.jsdelivr\\.net/.test(src)),
      withIntegrity: scripts.filter((s) => /cdn\\.jsdelivr\\.net/.test(s.src) && s.integrity).length,
      stylesheetSrc: (document.querySelector('link[rel=stylesheet][href*="cdn.jsdelivr.net"]') || {}).href || null,
      members: {
        createGrid: typeof (window.LatticeGrid || {}).createGrid,
        setLicence: typeof (window.LatticeGrid || {}).setLicence,
        createChart: typeof (window.LatticeGrid || {}).createChart,
        createDataRouter: typeof (window.LatticeGridDataRouter || {}).createDataRouter,
        createKPI: typeof (window.LatticeGridKPI || {}).createKPI,
        createTabs: typeof (window.LatticeGridTabs || {}).createTabs,
      },
    };
  })()`);
  console.log(`  library tags: ${delivery.librarySrcs.length} from the CDN, ${delivery.withIntegrity} with an integrity hash; module scripts on the page: ${delivery.moduleScripts}`);
  check(delivery.moduleScripts === 0, 'delivery: no type="module" script on the page', `${delivery.moduleScripts}`);
  check(delivery.importmaps === 0, 'delivery: no import map on the page', `${delivery.importmaps}`);
  check(
    delivery.librarySrcs.length === LIBRARY_TAGS.length,
    `delivery: ${LIBRARY_TAGS.length} library script tags point at the CDN`,
    `${delivery.librarySrcs.length}`,
  );
  for (const tag of LIBRARY_TAGS) {
    const wanted = `${CDN_BASE}${tag.file}`;
    check(delivery.librarySrcs.includes(wanted), `delivery: ${tag.file} is loaded from the pinned ${GRID_VERSION} release`, wanted);
    check(delivery.members[tag.member] === 'function', `delivery: ${tag.file} left ${tag.global}.${tag.member} behind`, delivery.members[tag.member]);
  }
  check(delivery.withIntegrity === LIBRARY_TAGS.length, 'delivery: every library tag carries an integrity hash', `${delivery.withIntegrity} of ${LIBRARY_TAGS.length}`);
  check(
    delivery.stylesheetSrc === `${CDN_BASE}lattice-grid.min.css`,
    `delivery: the stylesheet is loaded from the pinned ${GRID_VERSION} release`,
    delivery.stylesheetSrc,
  );
  check(delivery.members.setLicence === 'function', 'delivery: setLicence is on the core global');

  /* ---- the whole window is on hand, from one load ---- */

  const loaded = await evaluate(`(() => {
    const d = window.__tradeDemo;
    return {
      complete: d.complete,
      months: d.store.size,
      failed: d.timings.monthsFailed,
      windowRows: d.windowGrid.rows.totalCount(),
      disabledOptions: [...d.monthSelect.options].filter((o) => o.disabled).length,
      options: d.monthSelect.options.length,
      timings: d.timings,
    };
  })()`);
  console.log(`  months read: ${loaded.months} of ${meta.months.length}; window ${loaded.windowRows} rows; timings ${JSON.stringify(loaded.timings)}`);
  check(loaded.complete === true, 'saved copy: the page reports the whole copy read before it drew', `${loaded.complete}`);
  check(loaded.months === meta.months.length, 'saved copy: every saved month was read', `${loaded.months} of ${meta.months.length}`);
  check(loaded.failed === 0, 'saved copy: no saved month failed to read', `${loaded.failed}`);
  check(loaded.windowRows === meta.rows, 'saved copy: the window grid holds every saved row from one load', `${loaded.windowRows} against ${meta.rows}`);
  check(loaded.options === meta.months.length && loaded.disabledOptions === 0, 'saved copy: the month selector offers every month', `${loaded.options} options, ${loaded.disabledOptions} disabled`);

  const snap = await evaluate(`(() => {
    const d = window.__tradeDemo;
    return {
      rows: d.allGrid.rows.count(),
      columns: d.allGrid.columns.visible().length,
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      charts: d.charts.length,
      watermark: d.allGrid.licence.watermark(),
      licenceState: d.allGrid.licence.state(),
      badge: (document.querySelector('.head-note .pill') || {}).textContent || null,
      freshness: (document.querySelector('.freshness') || {}).textContent || null,
    };
  })()`);
  console.log(`  ${snap.rows} rows, ${snap.columns} columns, ${snap.painted} painted, ${snap.charts} charts; badge "${snap.badge}"`);
  console.log(`  ${snap.freshness}`);
  check(snap.rows > 0, 'saved copy: the table holds rows', `${snap.rows}`);
  check(snap.painted > 0, 'saved copy: the table painted rows', `${snap.painted}`);
  check(snap.charts === 4, 'saved copy: all four charts were built', `${snap.charts}`);
  check(snap.badge === 'Saved copy', 'saved copy: the badge says it is the saved copy', `"${snap.badge}"`);
  check(/copy of HMRC/.test(snap.freshness || ''), 'saved copy: the readout says when the copy was taken', snap.freshness);
  check(snap.watermark === false, 'saved copy: no watermark on localhost', `state ${snap.licenceState}`);

  /* Built is not drawn. A chart whose points all carry a null measure puts an
     empty pair of axes on the page and reports no error, so each one is asked
     what it actually plotted. */
  /* A treemap's bound data is a tree rather than series, so it reports
     whether it was empty and how many leaves it laid out. */
  const drawn = await evaluate(`(() => window.__tradeDemo.charts.map((c, i) => {
    const data = c.data();
    const series = (data && data.series) || [];
    const points = series.reduce((n, s) => n + ((s.points || []).length), 0);
    let withValue = series.reduce((n, s) => n + (s.points || []).filter((p) => p.y != null && p.y !== 0).length, 0);
    if (data && data.root) {
      /* A node's \`value\` is its label; \`total\` is the measure it holds. */
      const walk = (node) => (node.children && node.children.length ? node.children.reduce((n, k) => n + walk(k), 0) : (node.total > 0 ? 1 : 0));
      withValue = data.empty ? 0 : walk(data.root);
    }
    const svg = c.element;
    const marks = svg ? svg.querySelectorAll('rect, circle, path').length : 0;
    return { i, kind: data && data.root ? 'tree' : 'series', series: series.length, points, withValue, marks };
  }))()`);
  for (const c of drawn) {
    console.log(`  chart ${c.i} (${c.kind}): ${c.series} series, ${c.points} points, ${c.withValue} with a value, ${c.marks} marks`);
    check(c.withValue > 0, `saved copy: chart ${c.i} plotted values rather than empty axes`, `${c.withValue} carry a measure`);
    check(c.marks > 2, `saved copy: chart ${c.i} drew marks`, `${c.marks} marks`);
  }
  check(drawn[1] && drawn[1].series === 2, 'saved copy: the trend chart has an exports line and an imports line', `${drawn[1] && drawn[1].series} series`);
  check(drawn[1] && drawn[1].points === 2 * meta.months.length, 'saved copy: the trend chart has a point per month per flow', `${drawn[1] && drawn[1].points} against ${2 * meta.months.length}`);
  noErrors('saved copy');
  await shoot('01-grid-saved');

  /* ---- the headline figures against the saved files ---- */

  const first = await readFigures();
  console.log(`  shown tiles for ${first.selected}: ${JSON.stringify(first)}`);
  check(first.selected === newest, 'saved copy: the page opens on the newest month', `${first.selected} against ${newest}`);
  compareFigures('saved copy', first, expected);
  /* With the whole month in view the window is not narrowed at all, so the
     trend holds every saved row, including series that exist only in older
     months. Narrowed, it holds the rows of every month whose series is in
     view; both are counted here from the saved files. */
  const newestKeys = new Set(newestRows.map((r) => r.key));
  const allMonths = new Map();
  let savedRowsTotal = 0;
  for (const month of meta.months) {
    const rows = month === newest ? newestRows : month === previous ? previousRows : await savedMonth(month);
    allMonths.set(month, rows);
    savedRowsTotal += rows.length;
  }
  const trendRowsFor = (keys) => {
    let n = 0;
    for (const rows of allMonths.values()) for (const row of rows) if (keys.has(row.key)) n += 1;
    return n;
  };
  check(first.keysInView === newestKeys.size, 'saved copy: every series of the month is in view', `${first.keysInView} against ${newestKeys.size} keys`);
  check(savedRowsTotal === meta.rows, 'saved copy: the month files hold the rows meta.json counts', `${savedRowsTotal} against ${meta.rows}`);
  check(first.trendRows === savedRowsTotal, 'saved copy: the trend holds every saved row when nothing is narrowed', `${first.trendRows} against ${savedRowsTotal} rows`);

  /* ---- narrowing moves the tiles, the charts and the trend ---- */

  const before = await evaluate(`(() => {
    const d = window.__tradeDemo;
    return {
      rows: d.allGrid.rows.count(),
      trendRows: d.trendRowCount(),
      chartRows: d.charts.map((c) => { const data = c.data(); return data ? JSON.stringify(data).length : 0; }),
    };
  })()`);
  await evaluate('window.__tradeDemo.bigButton.click()');
  await sleep(900);
  const after = await readFigures();
  const afterCharts = await evaluate(`(() => {
    const d = window.__tradeDemo;
    return {
      pressed: d.bigButton.getAttribute('aria-pressed'),
      chartRows: d.charts.map((c) => { const data = c.data(); return data ? JSON.stringify(data).length : 0; }),
      minValue: (() => { let m = Infinity; d.allGrid.rows.forEach((r) => { if (r && r.data && typeof r.data.value === 'number' && r.data.value < m) m = r.data.value; }); return m; })(),
    };
  })()`);
  const bigRows = newestRows.filter((r) => r.value >= BIG_TRADE);
  const expectedBig = figures(bigRows, previousRows);
  console.log(`  narrowed: ${before.rows} rows -> ${after.rows} rows; trend ${before.trendRows} -> ${after.trendRows} rows`);
  check(afterCharts.pressed === 'true', 'the quick filter reports itself pressed');
  check(after.rows < before.rows, 'the quick filter narrows the table', `${before.rows} -> ${after.rows}`);
  check(afterCharts.minValue >= BIG_TRADE, 'every remaining row is over the threshold', `smallest ${afterCharts.minValue}`);
  compareFigures('narrowed', after, expectedBig);
  const chartsMoved = afterCharts.chartRows.filter((size, i) => size !== before.chartRows[i]).length;
  check(chartsMoved > 0, 'the charts rebound to the narrowed data', `${chartsMoved} of ${afterCharts.chartRows.length} changed`);
  check(after.trendRows < before.trendRows, 'the trend chart narrows to the series in view', `${before.trendRows} -> ${after.trendRows}`);
  const expectedNarrowedTrend = trendRowsFor(new Set(bigRows.map((r) => r.key)));
  check(after.trendRows === expectedNarrowedTrend, 'the narrowed trend holds every month of exactly the series in view', `${after.trendRows} against ${expectedNarrowedTrend}`);
  await shoot('02-narrowed');

  await evaluate('window.__tradeDemo.bigButton.click()');
  await sleep(700);
  const restored = await readFigures();
  check(restored.rows === before.rows, 'removing the quick filter restores the table', `${restored.rows} of ${before.rows}`);
  check(restored.trendRows === before.trendRows, 'removing the quick filter restores the trend', `${restored.trendRows} of ${before.trendRows}`);

  /* ---- another month through the router ---- */

  const previousExpected = figures(previousRows, meta.months.includes(T.previousMonth(previous)) ? await savedMonth(T.previousMonth(previous)) : []);
  const switched = await evaluate(`(async () => {
    const d = window.__tradeDemo;
    const ok = d.selectMonth(${JSON.stringify(previous)});
    await new Promise((r) => setTimeout(r, 900));
    return ok;
  })()`);
  const other = await readFigures();
  console.log(`  month ${previous}: ${other.rows} rows, select reads ${other.selectValue}`);
  check(switched === true, 'the month selector accepts a saved month');
  check(other.selected === previous && other.selectValue === previous, 'the month selector shows the chosen month', `${other.selectValue}`);
  compareFigures(`month ${previous}`, other, previousExpected);
  await shoot('03-previous-month');
  await evaluate(`window.__tradeDemo.selectMonth(${JSON.stringify(newest)})`);
  await sleep(900);
  const back = await readFigures();
  check(back.rows === expected.rows && same(back.exports, expected.exports), 'returning to the newest month restores its figures', `${back.rows} rows, exports ${back.exports}`);

  /* ---- grouping ---- */

  await evaluate("window.__tradeDemo.allGrid.columns.group(['partner'])");
  await sleep(700);
  const grouped = await evaluate(`(() => {
    const d = window.__tradeDemo;
    let groups = 0;
    d.allGrid.rows.forEach((r) => { if (r && r.group) groups += 1; });
    return { groups, tiles: Object.fromEntries(d.kpi.tiles().map((t) => [t.id, t.value])) };
  })()`);
  check(grouped.groups > 0, 'grouping by partner produces group rows', `${grouped.groups} groups`);
  check(grouped.groups === expected.partners, 'there is one group per partner in the month', `${grouped.groups} against ${expected.partners}`);
  check(same(grouped.tiles.exports, expected.exports), 'the rows under collapsed groups still count towards the tiles', `${grouped.tiles.exports} against ${expected.exports}`);
  await shoot('04-grouped-by-partner');
  await evaluate('window.__tradeDemo.allGrid.columns.group([])');
  await sleep(400);

  /* ---- the flow tabs ---- */

  for (const [id, flow, slot] of [['exports', 'Exports', 'exportsGrid'], ['imports', 'Imports', 'importsGrid']]) {
    await evaluate(`window.__tradeDemo.tabs.activate(${JSON.stringify(id)})`);
    await waitFor(`window.__tradeDemo.${slot} && window.__tradeDemo.${slot}.rows.count() > 0`, 30000, `the ${flow} table`);
    const tab = await evaluate(`(() => {
      const d = window.__tradeDemo;
      let allFlow = true;
      d.${slot}.rows.forEach((r) => { if (r && r.data && r.data.flow !== ${JSON.stringify(flow)}) allFlow = false; });
      return { rows: d.${slot}.rows.count(), allFlow, painted: document.querySelectorAll('.lattice [role="row"]').length };
    })()`);
    const expectedFlow = newestRows.filter((r) => r.flow === flow).length;
    console.log(`  ${flow} table: ${tab.rows} rows, saved copy holds ${expectedFlow}`);
    check(tab.rows === expectedFlow, `the ${flow} table holds exactly the month's ${flow.toLowerCase()} rows`, `${tab.rows} against ${expectedFlow}`);
    check(tab.allFlow, `the ${flow} table holds only ${flow.toLowerCase()}`);
    await shoot(`05-${id}-tab`);
  }
  await evaluate("window.__tradeDemo.tabs.activate('all')");
  await sleep(300);
  noErrors('saved copy, after the checks');

  /* ---- the page never called the API ---- */

  const apiCalls = requested.filter((url) => url.includes(API_HOST));
  check(apiCalls.length === 0, 'the page made no request to the HMRC API, which a browser cannot read', `${apiCalls.length} requests`);

  /* =================================================================== */
  /* 2. The API blocked in the browser: nothing changes.                  */
  /* =================================================================== */

  /*
   * The API cannot be read from a browser on another web address, so the
   * page never asks it. Blocking it here proves that: the default page,
   * with no parameter in the address, must open on the same rows with the
   * same badge and nothing logged.
   */
  await call('Network.setBlockedURLs', { urls: [`*${API_HOST}*`] });
  requested.length = 0;
  await open(`${origin}/index.html`, 'default page, with the API blocked');
  const blocked = await evaluate(`(() => {
    const d = window.__tradeDemo;
    return {
      rows: d.allGrid.rows.count(),
      months: d.store.size,
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      badge: (document.querySelector('.head-note .pill') || {}).textContent || null,
      notice: (document.querySelector('.notice') || {}).textContent || null,
      exports: d.kpi.value('exports'),
    };
  })()`);
  console.log(`  rows ${blocked.rows}, months ${blocked.months}, badge "${blocked.badge}"`);
  check(blocked.rows === expected.rows, 'blocked: the same rows are on screen', `${blocked.rows} against ${expected.rows}`);
  check(blocked.months === meta.months.length, 'blocked: every saved month was still read', `${blocked.months}`);
  check(blocked.painted > 0, 'blocked: the table painted rows', `${blocked.painted}`);
  check(blocked.badge === 'Saved copy', 'blocked: the badge reads "Saved copy"', `"${blocked.badge}"`);
  check(blocked.notice === null, 'blocked: no warning is shown, because nothing was attempted', blocked.notice);
  check(same(blocked.exports, expected.exports), 'blocked: the tiles read the saved copy', `${blocked.exports}`);
  check(requested.filter((url) => url.includes(API_HOST)).length === 0, 'blocked: the page still made no request to the API');
  noErrors('blocked');
  await shoot('06-blocked');
  await call('Network.setBlockedURLs', { urls: [] });

  socket.close();
} catch (error) {
  failures.push(String((error && error.stack) || error));
} finally {
  /* Take the whole browser tree down, not just the process that was spawned:
     a surviving renderer is an orphan nobody will reap. Only the browser this
     check started. */
  if (browserPid) {
    try { process.kill(-browserPid, 'SIGKILL'); } catch {}
    try { process.kill(browserPid, 'SIGKILL'); } catch {}
  }
  if (server) server.close();
  await sleep(400);
  if (profile) await rm(profile, { recursive: true, force: true });
}

console.log('\nChecks:');
for (const note of notes) console.log(note);

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nAll ${notes.length} checks passed.`);
process.exit(0);
