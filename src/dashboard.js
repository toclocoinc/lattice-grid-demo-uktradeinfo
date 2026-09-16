/**
 * The dashboard: one month of trade in the router, and every view built on
 * top of it.
 *
 * The data router is the hub. Nothing here fetches anything and nothing here
 * reaches for the grid's globals: every factory is handed in, so this file
 * would be the same whether the library arrived by script tag, as it does
 * here, or by import.
 *
 * How the pieces fit together:
 *
 *   the saved copy  ->  the router  ->  the All trade grid  ->  the tiles
 *      (a month)                    ->  the Exports grid        four charts
 *                                   ->  the Imports grid
 *
 * The month selector puts a different month through the router. That is a
 * keyed diff, so the rows the two months share are updated in place and only
 * what changed is repainted; the tiles, the charts and the tab counts follow
 * without being told.
 *
 * The one view that reads more than the month on screen is the trend chart.
 * It is a viewer of a second dataset: a headless grid holding every saved
 * month, and a derived grid over it that adds the months up by flow. The
 * trend still follows the table: the window grid is narrowed to the chapter,
 * partner and flow combinations the table currently matches, so narrowing
 * the table to one partner narrows the trend to that partner.
 *
 * A classic script: it reads the shared constants from `TradeDemo`, put there
 * by `hmrc-api.js`, and adds `buildDashboard` alongside them.
 */
(function (root) {
  'use strict';

  const { monthLabel, previousMonth } = root.TradeDemo;

  const TITLE = 'UK goods trade, month by month';

  /** The threshold behind the quick filter: a chapter and partner worth this much in a month. */
  const BIG_TRADE = 10000000;

  /** Make an element with a class and optional text, the long way round. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** A sum of money, in pounds, written the way a reader expects to see it. */
  function pounds(value) {
    const n = Number(value || 0);
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 1e9) return `${sign}£${(abs / 1e9).toFixed(2)}bn`;
    if (abs >= 1e6) return `${sign}£${(abs / 1e6).toFixed(1)}m`;
    if (abs >= 1e3) return `${sign}£${Math.round(abs / 1e3).toLocaleString('en-GB')}k`;
    return `${sign}£${Math.round(abs).toLocaleString('en-GB')}`;
  }

  /* ------------------------------------------------------------------ */
  /* Columns                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The trade columns, grouped under three headings.
   *
   * Money is formatted by the grid as sterling with no pence, because HMRC
   * publishes whole pounds. Net mass is shown in tonnes; it is null where
   * HMRC suppressed it, and nothing assumes it is a number.
   *
   * @returns {object[]} the column definitions
   */
  function tradeColumns() {
    const money = {
      type: 'number',
      format: { style: 'currency', currency: 'GBP', decimals: 0 },
      filter: { type: 'number' },
      total: 'sum',
      groupTotal: 'sum',
    };

    return [
      {
        title: 'What',
        columns: [
          {
            id: 'section',
            field: 'section',
            title: 'Section',
            filter: { type: 'set' },
            layout: { width: 80 },
          },
          {
            id: 'sectionName',
            field: 'sectionName',
            title: 'Section name',
            filter: { type: 'set' },
            layout: { width: 220, hidden: true },
          },
          {
            id: 'sectionShort',
            field: 'sectionShort',
            title: 'Section, short',
            filter: { type: 'set' },
            layout: { width: 160, hidden: true },
          },
          {
            id: 'chapter',
            field: 'chapter',
            title: 'Chapter',
            filter: { type: 'set' },
            layout: { width: 84 },
          },
          {
            id: 'chapterName',
            field: 'chapterName',
            title: 'Commodities',
            filter: { type: 'text' },
            layout: { width: 320 },
          },
        ],
      },
      {
        title: 'With whom',
        columns: [
          {
            id: 'partner',
            field: 'partner',
            title: 'Partner',
            filter: { type: 'set' },
            layout: { width: 140 },
          },
          {
            id: 'region',
            field: 'region',
            title: 'Region',
            filter: { type: 'set' },
            layout: { width: 170 },
          },
          {
            id: 'regionShort',
            field: 'regionShort',
            title: 'Region, short',
            filter: { type: 'set' },
            layout: { width: 140, hidden: true },
          },
        ],
      },
      {
        title: 'The trade',
        columns: [
          {
            id: 'flow',
            field: 'flow',
            title: 'Flow',
            filter: { type: 'set' },
            layout: { width: 90 },
          },
          {
            id: 'monthLabel',
            field: 'monthLabel',
            title: 'Month',
            filter: { type: 'set' },
            layout: { width: 120 },
          },
          {
            ...money,
            id: 'value',
            field: 'value',
            title: 'Value',
            /* Largest first, which is what a trade table should open on. It
               also decides the order of the categories in the charts: a chart
               lays them out in the order the table walks its rows. */
            sort: { direction: 'desc' },
            layout: { width: 150 },
          },
          {
            id: 'mass',
            field: 'mass',
            title: 'Net mass (tonnes)',
            type: 'number',
            format: { decimals: 1, nullDisplay: 'suppressed' },
            filter: { type: 'number' },
            total: 'sum',
            groupTotal: 'sum',
            layout: { width: 150 },
          },
          {
            ...money,
            id: 'balance',
            field: 'balance',
            title: 'Balance',
            /* Exports count for, imports against: this column's total over any
               set of rows is the trade balance for that set, so a group
               subtotal by partner is the balance with that partner. */
            layout: { width: 150 },
          },
          /* The two fields below are for the tiles and the charts rather than
             the reader, so they start out of the way. */
          {
            id: 'month',
            field: 'month',
            title: 'Month key',
            filter: { type: 'set' },
            layout: { width: 100, hidden: true },
          },
          {
            id: 'key',
            field: 'key',
            title: 'Series key',
            filter: { type: 'none' },
            sort: false,
            layout: { width: 200, hidden: true },
          },
          {
            id: 'count',
            field: 'count',
            title: 'Rows',
            type: 'number',
            total: 'sum',
            groupTotal: 'sum',
            filter: { type: 'none' },
            layout: { width: 80, hidden: true },
          },
        ],
      },
    ];
  }

  /**
   * The colour on the balance column, and a weight on the largest trades.
   *
   * These are conditional formatting rules the grid holds as runtime state, so
   * a reader can open the Formatting panel and change them.
   *
   * @returns {object} rules keyed by column id
   */
  function formattingRules() {
    return {
      balance: [
        {
          id: 'surplus',
          label: 'Surplus: exports exceed imports',
          when: { op: 'gt', value: 0 },
          style: { color: '#1b5e20', fontWeight: '600' },
        },
        {
          id: 'deficit',
          label: 'Deficit: imports exceed exports',
          when: { op: 'lt', value: 0 },
          style: { color: '#b3261e', fontWeight: '600' },
        },
      ],
      value: [
        {
          id: 'big',
          label: 'Over £100m in the month',
          when: { op: 'gte', value: 100000000 },
          style: { fontWeight: '700' },
        },
      ],
    };
  }

  /**
   * The shared grid settings all three tables use.
   *
   * @param {string} title the table's heading
   * @returns {object} a partial grid config
   */
  function baseGridConfig(title) {
    return {
      rowKey: 'id',
      columns: tradeColumns(),
      formatting: formattingRules(),
      theme: 'light',
      density: 'compact',
      stripedRows: true,
      columnMenu: true,
      groupPanel: true,
      statusBar: true,
      find: true,
      grandTotalRow: 'bottom',
      groupDefaultExpanded: 0,
      toolPanel: { side: 'right', panels: ['filters', 'columns', 'formatting'] },
      selection: 'multiple',
      title,
      rows: [],
    };
  }

  /* ------------------------------------------------------------------ */
  /* The dashboard                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Build the whole page into `root`.
   *
   * @param {object} options
   * @param {HTMLElement} options.root where the dashboard is drawn
   * @param {Function} options.createGrid the grid factory
   * @param {Function} options.createHeadlessGrid the factory for a grid with no DOM
   * @param {Function} options.createChart the charts module's factory
   * @param {Function} options.createKPI the KPI module's factory
   * @param {Function} options.createTabs the tabs module's factory
   * @param {Function} options.createDataRouter the data router module's factory
   * @param {object} options.meta the saved copy's `meta.json`
   * @param {Map<string, object[]>} options.store the saved months, rows by month
   * @param {string} options.selected the month to open on
   * @returns {object} the pieces that were built, for a caller that wants them
   */
  function buildDashboard({
    root: host,
    createGrid,
    createHeadlessGrid,
    createChart,
    createKPI,
    createTabs,
    createDataRouter,
    meta,
    store,
    selected,
  }) {
    host.textContent = '';

    const built = {
      allGrid: null,
      exportsGrid: null,
      importsGrid: null,
      windowGrid: null,
      trendGrid: null,
      router: null,
      kpi: null,
      charts: [],
      tabs: null,
      store,
      selected,
      meta,
    };

    const partnerCount = meta.partners.length;

    /* ---------------- the masthead ---------------- */

    const header = el('header', 'head');
    const heading = el('div', 'head-text');
    heading.append(el('h1', null, TITLE));
    heading.append(
      el(
        'p',
        'lede',
        `What the United Kingdom imported and exported, by commodity chapter, with its ${partnerCount} largest ` +
          `trading partners, over the ${meta.months.length} months to ${monthLabel(meta.newest)}. ` +
          'Pick a month; group, sort and filter the table; the figures and the charts follow it.',
      ),
    );
    if (meta.partial) {
      heading.append(
        el('p', 'notice', `${meta.partial} of the saved months could not be read, so the trend and the month list are incomplete.`),
      );
    }
    header.append(heading);

    const provenance = el('div', 'head-note');
    const modePill = el('span', 'pill', 'Saved copy');
    const freshness = el('span', 'freshness', '');
    provenance.append(modePill, freshness);
    header.append(provenance);
    host.append(header);

    /* ---------------- the tiles ---------------- */

    const kpiHost = el('section', 'kpi-strip');
    kpiHost.setAttribute('aria-label', 'Headline figures');
    const panelHost = el('div', 'kpi-panel');
    const namedTile = el('div', 'kpi-named');
    const namedValue = el('div', 'kpi-named-value', 'No data');
    const namedLabel = el('div', 'kpi-named-label', 'Largest partner in view');
    namedTile.append(namedValue, namedLabel);
    kpiHost.append(panelHost, namedTile);
    host.append(kpiHost);

    /* ---------------- the charts ---------------- */

    const chartHost = el('section', 'chart-wrap');
    chartHost.setAttribute('aria-label', 'Charts');
    const chartBoxes = [];
    for (let i = 0; i < 4; i += 1) {
      const box = el('div', 'chart-box');
      chartHost.append(box);
      chartBoxes.push(box);
    }
    host.append(chartHost);

    /* ---------------- the controls ---------------- */

    const actions = el('div', 'actions');
    host.append(actions);

    /* ---------------- the tables ---------------- */

    const tabsHost = el('section', 'tabs-host');
    host.append(tabsHost);

    const tabs = createTabs(tabsHost, {
      createGrid,
      /* So a tab that has not been opened yet still carries a live count. */
      createHeadlessGrid,
      ariaLabel: 'Trade views',
      tabs: [
        {
          id: 'all',
          label: 'Imports and exports',
          badge: true,
          config: baseGridConfig('Imports and exports, by chapter and partner'),
        },
        /*
         * The flow tabs derive from the combined table: the tabs module
         * builds each one's source over the first tab's rows, narrowed by
         * `where`, and keeps it in step as the month changes. `follow: 'all'`
         * means a filter set on the combined table does not narrow them;
         * each is a plain view of its flow for the month on screen.
         */
        {
          id: 'exports',
          label: 'Exports',
          badge: true,
          from: 'all',
          where: (row) => row.flow === 'Exports',
          follow: 'all',
          config: baseGridConfig('Exports, by chapter and partner'),
        },
        {
          id: 'imports',
          label: 'Imports',
          badge: true,
          from: 'all',
          where: (row) => row.flow === 'Imports',
          follow: 'all',
          config: baseGridConfig('Imports, by chapter and partner'),
        },
      ],
    });
    built.tabs = tabs;
    built.allGrid = tabs.tab('all');

    /* ---------------- the router ---------------- */

    /*
     * One month in, one table out, and everything else derived from or bound
     * to that table. A load is a keyed diff: when the month changes, the rows
     * the two months share are updated in place and only what changed is
     * repainted, and the flow tabs, the tiles and the charts follow.
     */
    const router = createDataRouter({
      key: 'flow',
      rowKey: 'id',
    });
    built.router = router;
    router.attach(built.allGrid, () => true);

    /* The flow tables are built the first time their tab is opened; they are
       remembered here for anyone who wants them. */
    tabs.on('tab:changed', (event) => {
      if (event.id === 'exports' && !built.exportsGrid) built.exportsGrid = tabs.tab('exports');
      if (event.id === 'imports' && !built.importsGrid) built.importsGrid = tabs.tab('imports');
    });

    /* The first load. */
    router.load(store.get(selected) || []);

    /* ---------------- the window, for the trend ---------------- */

    /*
     * Every saved month, in a grid with no DOM. Only the fields the trend
     * needs are declared, so the grid does no more work than that. The saved
     * copy is one dataset, so it goes in as one load, oldest month first.
     */
    const windowRows = [];
    for (const month of [...store.keys()].sort()) windowRows.push(...store.get(month));
    const windowGrid = createHeadlessGrid({
      rowKey: 'id',
      columns: [
        { id: 'month', field: 'month', title: 'Month' },
        { id: 'flow', field: 'flow', title: 'Flow' },
        { id: 'key', field: 'key', title: 'Series key' },
        { id: 'value', field: 'value', title: 'Value', type: 'number' },
      ],
      rows: [],
    });
    windowGrid.rows.load(windowRows);
    built.windowGrid = windowGrid;

    /*
     * The months added up by flow, derived from the window grid and
     * following its filter. Forty-eight rows for the chart to draw rather
     * than a hundred thousand, and it re-derives itself when the window
     * grid changes.
     */
    const trendGrid = createHeadlessGrid({
      rowKey: '__key',
      source: {
        mode: 'derived',
        from: windowGrid,
        follow: 'filtered',
        groupBy: ['month', 'flow'],
        select: { value: { of: 'value', fn: 'sum' } },
        sort: [{ col: 'month', dir: 'asc' }, { col: 'flow', dir: 'asc' }],
      },
      columns: [
        { id: 'month', field: 'month', title: 'Month' },
        { id: 'flow', field: 'flow', title: 'Flow' },
        { id: 'value', field: 'value', title: 'Value', type: 'number', format: { style: 'currency', currency: 'GBP', decimals: 0 } },
      ],
    });
    built.trendGrid = trendGrid;
    built.trendRowCount = () => windowGrid.rows.count();

    /* ---------------- the tiles, bound to the combined table ---------------- */

    /**
     * The previous month's rows by series key, for the month-on-month tile.
     * Rebuilt when the month changes or when that month arrives.
     */
    let previousByKey = new Map();
    const indexPrevious = () => {
      previousByKey = new Map();
      const rows = store.get(previousMonth(built.selected));
      if (rows) for (const row of rows) previousByKey.set(row.key, row);
    };
    indexPrevious();

    /** The chapter, partner and flow combinations the table currently matches. */
    let keysInView = new Set();
    built.keysInView = () => keysInView;

    /**
     * Narrow the window to the series in view, or widen it back to everything
     * when the table matches the whole month. A named predicate: it is the
     * window grid's own filter, and the derived grid and the chart follow it.
     */
    const narrowWindow = () => {
      const whole = (store.get(built.selected) || []).length;
      const keys = keysInView;
      windowGrid.filters.where('inView', keys.size >= whole ? null : (row) => keys.has(row.key));
    };

    const kpi = createKPI(panelHost, {
      /*
       * Bound to the table. The panel reads what the table currently matches
       * and follows it on its own: a filter, a grouping (the rows under a
       * collapsed heading included), a month change and a removal all reach
       * the tiles without the host handing it anything.
       */
      grid: built.allGrid,
      rowKey: 'id',
      /* The columns the custom tiles and the named reading below need on each
         projected row. `value` and `balance` are declared by tiles; the other
         three are declared by nothing else, so without this they would not be
         there to read. */
      fields: ['value', 'balance', 'flow', 'partner', 'key'],
      columns: 5,
      ariaLabel: 'Headline figures',
      tiles: [
        {
          id: 'exports',
          label: 'Exports in view',
          aggregation: 'sum',
          field: 'value',
          filter: (row) => row.flow === 'Exports',
          format: { type: 'currency', currency: 'GBP', decimals: 0 },
        },
        {
          id: 'imports',
          label: 'Imports in view',
          aggregation: 'sum',
          field: 'value',
          filter: (row) => row.flow === 'Imports',
          format: { type: 'currency', currency: 'GBP', decimals: 0 },
        },
        {
          id: 'balance',
          label: 'Trade balance in view',
          aggregation: 'sum',
          field: 'balance',
          format: { type: 'currency', currency: 'GBP', decimals: 0 },
          /* Green above zero, red below: the sign is the reading. */
          bands: [
            { min: 0, status: 'good' },
            { max: 0, status: 'critical' },
          ],
        },
        {
          id: 'change',
          label: 'Change on the month before',
          aggregation: 'custom',
          format: { type: 'percent', decimals: 1 },
          /*
           * Like for like. The comparison is between the same chapter,
           * partner and flow combinations in the two months: a combination
           * traded this month but not last is left out of both sides, and the
           * whole of the previous month is never the yardstick. Narrowing the
           * table to Germany compares Germany with Germany.
           */
          compute: (tileRows) => {
            let now = 0;
            let before = 0;
            let matched = 0;
            for (const row of tileRows) {
              const prior = previousByKey.get(row.key);
              if (!prior) continue;
              now += Number(row.value) || 0;
              before += prior.value;
              matched += 1;
            }
            if (!matched || !before) return null;
            return (now - before) / before;
          },
        },
        {
          id: 'partners',
          label: 'Partners in view',
          aggregation: 'countDistinct',
          field: 'partner',
          format: 'number',
        },
      ],
    });
    built.kpi = kpi;

    /**
     * Name the largest partner in view, and remember which series are in view.
     *
     * The one figure that is not a tile: it is a phrase with a country in it,
     * and a tile shows a number. So it is drawn by hand, but from the bound
     * panel's own rows rather than from a second walk of the table, each time
     * the panel says it has re-read the table. The same pass collects the
     * series keys the trend chart narrows to.
     */
    const refreshNamedTile = () => {
      const byPartner = new Map();
      const keys = new Set();
      kpi.rows.forEach((row) => {
        byPartner.set(row.partner, (byPartner.get(row.partner) || 0) + (Number(row.value) || 0));
        if (row.key) keys.add(row.key);
      });
      keysInView = keys;
      let biggest = null;
      for (const [partner, total] of byPartner) {
        if (!biggest || total > biggest.total) biggest = { partner, total };
      }
      if (!biggest) {
        namedValue.textContent = 'No data';
        namedLabel.textContent = 'Largest partner in view';
        return;
      }
      namedValue.textContent = `${biggest.partner}, ${pounds(biggest.total)}`;
      namedLabel.textContent = `Largest partner in view, imports and exports, ${monthLabel(built.selected)}`;
    };

    /* ---------------- the charts ---------------- */

    /* Three charts read the table on screen; the trend reads the derived
       grid over the window. Each follows its own grid. */
    const chartSpecs = [
      {
        grid: built.allGrid,
        type: 'treemap',
        x: 'partner',
        y: 'value',
        title: 'Who the trade is with',
        subtitle: 'Imports and exports in view, by partner',
        legend: false,
      },
      {
        grid: trendGrid,
        type: 'line',
        x: 'month',
        y: 'value',
        series: 'flow',
        title: 'Month by month',
        subtitle: 'Every saved month, for what the table matches',
        /* Two years of months do not all fit along the bottom; every third
           label is enough to read the axis. */
        axis: { x: { labels: true, rotate: 'auto', every: 3 } },
        legend: { position: 'bottom' },
      },
      {
        grid: built.allGrid,
        type: 'treemap',
        x: 'sectionShort',
        y: 'value',
        title: 'What is traded',
        subtitle: 'Imports and exports in view, by HS section',
        legend: false,
      },
      {
        grid: built.allGrid,
        type: 'horizontalBar',
        x: 'regionShort',
        y: 'value',
        series: 'flow',
        title: 'Imports and exports',
        subtitle: 'By world region',
        margin: { left: 118 },
        legend: { position: 'bottom' },
      },
    ];

    chartSpecs.forEach((spec, index) => {
      try {
        built.charts.push(createChart({ container: chartBoxes[index], ...spec }));
      } catch (error) {
        chartBoxes[index].append(el('p', 'chart-error', `This chart could not be drawn: ${error.message}`));
        console.error('[trade demo] chart', spec.type, error);
      }
    });
    built.trendChart = built.charts[1] || null;

    /* The series in view are known once the panel has re-read the table, so
       the window is narrowed then. */
    kpi.on('change', () => {
      refreshNamedTile();
      narrowWindow();
    });
    refreshNamedTile();
    narrowWindow();

    /* ---------------- the controls ---------------- */

    const button = (label, onClick, className) => {
      const node = el('button', className || 'action', label);
      node.type = 'button';
      node.addEventListener('click', onClick);
      return node;
    };

    /* The month selector. A month the saved copy lists but could not be
       read is shown, but cannot be chosen. */
    const monthSelect = el('select', 'month-select');
    monthSelect.setAttribute('aria-label', 'Month');
    for (const month of [...meta.months].sort().reverse()) {
      const option = el('option', null, monthLabel(month));
      option.value = month;
      option.disabled = !store.has(month);
      monthSelect.append(option);
    }
    monthSelect.value = selected;
    monthSelect.addEventListener('change', () => built.selectMonth(monthSelect.value));
    built.monthSelect = monthSelect;

    actions.append(el('span', 'actions-label', 'Month'));
    actions.append(monthSelect);

    const group = (ids) => () => built.allGrid && built.allGrid.columns.group(ids);

    actions.append(el('span', 'actions-gap'));
    actions.append(el('span', 'actions-label', 'Group by'));
    actions.append(button('Section', group(['sectionName'])));
    actions.append(button('Chapter', group(['chapterName'])));
    actions.append(button('Partner', group(['partner'])));
    actions.append(button('Region', group(['region'])));
    actions.append(button('Partner, then chapter', group(['partner', 'chapterName'])));
    actions.append(button('No grouping', group([])));

    actions.append(el('span', 'actions-gap'));
    actions.append(el('span', 'actions-label', 'Order by'));
    actions.append(button('Largest first', () => built.allGrid && built.allGrid.sort.set([{ col: 'value', dir: 'desc' }])));
    actions.append(button('Chapter order', () => built.allGrid && built.allGrid.sort.set([{ col: 'chapter', dir: 'asc' }, { col: 'partner', dir: 'asc' }])));

    const bigButton = button('Only trade over £10m', () => {
      const on = bigButton.getAttribute('aria-pressed') === 'true';
      /* A named row predicate: registering it is what activates it, and
         removing it by name leaves any other filter the reader has set
         untouched. */
      built.allGrid.filters.where('big', on ? null : (row) => Number(row.value) >= BIG_TRADE);
      bigButton.setAttribute('aria-pressed', String(!on));
      bigButton.classList.toggle('on', !on);
    }, 'action toggle');
    bigButton.setAttribute('aria-pressed', 'false');
    actions.append(el('span', 'actions-gap'));
    actions.append(bigButton);
    built.bigButton = bigButton;

    /* The grouping and ordering act on the combined table, so they only
       belong on its tab. The month selector belongs everywhere. */
    const tabActions = [...actions.children].slice(2);
    const showActionsFor = (id) => {
      for (const node of tabActions) node.hidden = id !== 'all';
    };
    showActionsFor(tabs.activeId);
    tabs.on('tab:changed', (event) => showActionsFor(event.id));

    /* ---------------- the readout ---------------- */

    /** Say what the reader is looking at, and how fresh it is. */
    const setFreshness = () => {
      const taken = new Date(meta.fetchedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      const share = meta.coverage && meta.coverage[built.selected] ? meta.coverage[built.selected].share : null;
      const coverage = share ? ` These ${partnerCount} partners carried ${(share * 100).toFixed(0)}% of UK goods trade by value that month.` : '';
      freshness.textContent =
        `${monthLabel(built.selected)}, from a copy of HMRC's figures taken on ${taken}; ` +
        `the newest month HMRC has published is ${monthLabel(meta.newest)}.${coverage}`;
    };
    built.setFreshness = setFreshness;

    /* ---------------- the month change ---------------- */

    /**
     * Put a different month through the router.
     *
     * @param {string} month `'2026-06'`
     * @returns {boolean} whether the month was on hand
     */
    built.selectMonth = (month) => {
      if (!store.has(month)) return false;
      built.selected = month;
      monthSelect.value = month;
      indexPrevious();
      /* A keyed diff: the rows the two months share are updated in place and
         only what changed is repainted. Every view follows. */
      router.load(store.get(month));
      kpi.refresh();
      setFreshness();
      return true;
    };

    setFreshness();

    /* ---------------- the footer ---------------- */

    const footer = el('footer', 'foot');
    const line = el('p', null, 'Contains public sector information licensed under the Open Government Licence v3.0. Source: ');
    const link = el('a', null, 'HM Revenue & Customs, uktradeinfo');
    link.href = meta.sourceUrl || 'https://www.uktradeinfo.com/';
    link.rel = 'noopener';
    line.append(link);
    line.append(
      document.createTextNode(
        `. Values are in pounds sterling as HMRC publishes them; net mass is in tonnes and is shown as suppressed where HMRC withheld it. ` +
          `The table holds the ${partnerCount} largest partners by value over the window; HMRC's estimates for trade below the ` +
          'reporting threshold, low-value trade, ships’ stores and confidential trade are not in it, so the totals here are ' +
          'below the headline figures HMRC publishes. Monthly figures are revised after first publication.',
      ),
    );
    footer.append(line);
    host.append(footer);

    built.destroy = () => {
      for (const chart of built.charts) chart.destroy();
      kpi.destroy();
      router.destroy();
      tabs.destroy();
      trendGrid.destroy();
      windowGrid.destroy();
    };

    return built;
  }

  root.TradeDemo.buildDashboard = buildDashboard;
})(typeof globalThis !== 'undefined' ? globalThis : window);
