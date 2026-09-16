/**
 * The entry point: read the saved copy, hand the newest month to the
 * dashboard, then read the other months in behind it.
 *
 * There is one source of data, the saved copy in `data/snapshot/`. The HMRC
 * API it was taken from answers without the cross-origin header a browser
 * needs, so a page on any other web address cannot read the API directly;
 * a nightly job reads it under Node instead and commits what it fetched.
 * The badge at the top says so, and says when the copy was taken.
 *
 * Two things can be asked for in the address:
 *
 *   ?month=2026-03       open on a month other than the newest
 *   ?source=snapshot     accepted for consistency with the other demos; it
 *                        names the only source this page has
 *
 * This is the script-tag edition. The grid and its modules arrived as classic
 * `<script src>` tags from jsDelivr, ahead of this file, and left globals
 * behind: `LatticeGrid` (the core, which the charts module extends),
 * `LatticeGridDataRouter`, `LatticeGridKPI` and `LatticeGridTabs`. This file
 * picks the factories off those globals and hands them to the dashboard, which
 * never touches a global itself.
 */
(function (root) {
  'use strict';

  const TITLE = 'UK goods trade, month by month';

  const host = document.querySelector('#app');
  const params = new URLSearchParams(location.search);
  const wantedMonth = /^\d{4}-\d{2}$/.test(params.get('month') || '') ? params.get('month') : null;

  /** Draw the waiting state, and return a function that updates its message. */
  function showProgress(first) {
    host.textContent = '';
    const panel = document.createElement('div');
    panel.className = 'loading';
    const title = document.createElement('h1');
    title.textContent = TITLE;
    const message = document.createElement('p');
    message.className = 'loading-message';
    message.textContent = first;
    const bar = document.createElement('div');
    bar.className = 'loading-bar';
    const fill = document.createElement('div');
    fill.className = 'loading-fill';
    bar.append(fill);
    panel.append(title, message, bar);
    host.append(panel);
    return (text, fraction) => {
      message.textContent = text;
      fill.style.width = `${Math.round((fraction || 0) * 100)}%`;
    };
  }

  /** Say what went wrong, in words a reader can act on. */
  function showError(error) {
    host.textContent = '';
    const panel = document.createElement('div');
    panel.className = 'loading';
    const title = document.createElement('h1');
    title.textContent = 'The trade figures could not be loaded';
    const message = document.createElement('p');
    message.className = 'loading-message';
    message.textContent = String((error && error.message) || error);
    const hint = document.createElement('p');
    hint.className = 'loading-message';
    hint.textContent = 'The page reads the saved copy in data/snapshot. Check that the folder is being served alongside the page.';
    panel.append(title, message, hint);
    host.append(panel);
    console.error('[trade demo]', error);
  }

  /**
   * The grid's factories, read off the globals the script tags left behind.
   *
   * Checked by name rather than assumed, so a script tag that did not load,
   * or loaded in the wrong order, is reported as the sentence it is rather
   * than as "undefined is not a function" somewhere inside the dashboard.
   *
   * @returns {object} the six factories and `setLicence`
   */
  function libraryFromGlobals() {
    const missing = [];
    const need = (object, name, what) => {
      const value = object && object[name];
      if (typeof value !== 'function') missing.push(what);
      return value;
    };
    const createGrid = need(root.LatticeGrid, 'createGrid', 'lattice-grid.min.js (LatticeGrid.createGrid)');
    const createHeadlessGrid = need(root.LatticeGrid, 'createHeadlessGrid', 'lattice-grid.min.js (LatticeGrid.createHeadlessGrid)');
    const setLicence = need(root.LatticeGrid, 'setLicence', 'lattice-grid.min.js (LatticeGrid.setLicence)');
    /* The charts module extends the core global rather than defining its own,
       so it has to be loaded after the core; this is where that shows. */
    const createChart = need(root.LatticeGrid, 'createChart', 'modules/charts.min.js (LatticeGrid.createChart)');
    const createDataRouter = need(root.LatticeGridDataRouter, 'createDataRouter', 'modules/data-router.min.js (LatticeGridDataRouter.createDataRouter)');
    const createKPI = need(root.LatticeGridKPI, 'createKPI', 'modules/kpi.min.js (LatticeGridKPI.createKPI)');
    const createTabs = need(root.LatticeGridTabs, 'createTabs', 'modules/tabs.min.js (LatticeGridTabs.createTabs)');
    if (missing.length) {
      throw new Error(
        `The grid did not load from the CDN. Missing: ${missing.join('; ')}. ` +
          'Check that the script tags in index.html are reachable and in order, with the core first.',
      );
    }
    return { createGrid, createHeadlessGrid, setLicence, createChart, createDataRouter, createKPI, createTabs };
  }

  /** One file of the saved copy. */
  async function readSaved(path) {
    const response = await fetch(`./data/snapshot/${path}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`The saved copy is missing ${path}.`);
    return response.json();
  }

  async function start() {
    const started = performance.now();
    try {
      const { createGrid, createHeadlessGrid, setLicence, createChart, createDataRouter, createKPI, createTabs } = libraryFromGlobals();
      const { buildDashboard, decodeMonth } = root.TradeDemo;

      /* Applied before anything is drawn, because a grid that already exists
         keeps whatever licence was in force when it was built. */
      setLicence(DEMO_LICENCE);

      const update = showProgress('Reading the saved copy...');
      const meta = await readSaved('meta.json');
      if (!Array.isArray(meta.months) || !meta.months.length) {
        throw new Error('The saved copy lists no months.');
      }
      const lookups = { partners: meta.partners, chapters: meta.chapters };

      /* The month to open on: the one asked for, if the copy holds it, else
         the newest. It is read first and on its own, so the page is on screen
         before the rest of the window has arrived. */
      const first = wantedMonth && meta.months.includes(wantedMonth) ? wantedMonth : meta.newest;
      update(`Reading ${first}...`, 0.2);
      const store = new Map();
      store.set(first, decodeMonth(await readSaved(`months/${first}.json`), lookups));

      const fetched = performance.now();
      update('Building the dashboard...', 0.4);

      const built = buildDashboard({
        root: host,
        createGrid,
        createHeadlessGrid,
        createChart,
        createKPI,
        createTabs,
        createDataRouter,
        meta,
        store,
        selected: first,
      });
      const builtAt = performance.now();

      /* Kept by reference, not copied: the flow tables are only created when
         their tab is first opened, and a copy taken now would never see them. */
      root.__tradeDemo = Object.assign(built, { ready: true, complete: false });

      /* The rest of the window, newest first, a few at a time. A month that
         cannot be read is counted and said at the top rather than stopping
         the others. */
      const remaining = [...meta.months].sort().reverse().filter((month) => month !== first);
      let failed = 0;
      const readOne = async (month) => {
        try {
          const rows = decodeMonth(await readSaved(`months/${month}.json`), lookups);
          built.addMonth(month, rows);
        } catch (error) {
          failed += 1;
          console.warn(`[trade demo] the saved month ${month} could not be read:`, error);
        }
      };
      const queue = [...remaining];
      const workers = [];
      for (let i = 0; i < 4; i += 1) {
        workers.push((async () => {
          while (queue.length) await readOne(queue.shift());
        })());
      }
      await Promise.all(workers);
      if (failed) {
        meta.partial = failed;
        const heading = host.querySelector('.head-text');
        if (heading) {
          const notice = document.createElement('p');
          notice.className = 'notice';
          notice.textContent = `${failed} of the saved months could not be read, so the trend and the month list are incomplete.`;
          heading.append(notice);
        }
      }

      const finished = performance.now();
      built.complete = true;
      built.timings = {
        month: first,
        monthsLoaded: store.size,
        monthsFailed: failed,
        rows: built.allGrid ? built.allGrid.rows.count() : 0,
        firstMonthMs: Math.round(fetched - started),
        buildMs: Math.round(builtAt - fetched),
        restMs: Math.round(finished - builtAt),
        totalMs: Math.round(finished - started),
      };
      console.log('[trade demo] ready', built.timings);
    } catch (error) {
      root.__tradeDemo = { ready: false, error: String((error && error.message) || error) };
      showError(error);
    }
  }

  start();
})(window);
