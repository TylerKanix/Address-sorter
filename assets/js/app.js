/*
 * Page logic: reading the spreadsheet, letting the person confirm columns
 * and options, running the lookups and the optimiser, and showing/exporting
 * the result.
 */
(function () {
  'use strict';

  const AS = window.AddressSorter;
  const A = AS.address;
  const G = AS.geo;

  const WALK_SPEED_MPS = 1.34; // about 3 mph
  const STRAIGHT_LINE_DETOUR = 1.2; // streets are rarely a straight line
  const NAV_CHUNK = 10; // stops per Google Maps link (origin + 8 waypoints + destination)

  const ROLES = [
    { key: 'address', label: 'Address' },
    { key: 'number', label: 'House number' },
    { key: 'unit', label: 'Apt / unit' },
    { key: 'city', label: 'Town / city' },
    { key: 'state', label: 'State' },
    { key: 'zip', label: 'ZIP / postcode' },
    { key: 'country', label: 'Country' },
    { key: 'lat', label: 'Latitude' },
    { key: 'lon', label: 'Longitude' },
  ];

  const PRECISION = {
    given: { label: 'From your file', cls: 'ok' },
    exact: { label: 'Found', cls: 'ok' },
    manual: { label: 'Placed by you', cls: 'ok' },
    street: { label: 'Street only', cls: 'warn', help: 'Only the street was found, so stops on it are ordered by house number.' },
    estimated: { label: 'Estimated', cls: 'warn', help: 'Not found; position estimated from nearby house numbers on the same street.' },
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, attrs) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const kids = [].concat(arguments[i]);
      for (const c of kids) {
        if (c === null || c === undefined || c === false) continue;
        node.append(c instanceof Node ? c : String(c));
      }
    }
    return node;
  }

  let storage = null;
  try {
    storage = window.localStorage;
    storage.getItem('address-sorter:probe');
  } catch (e) {
    storage = null;
  }
  function getPref(key, fallback) {
    try {
      const v = storage && storage.getItem('address-sorter:' + key);
      return v === null || v === undefined ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }
  function setPref(key, value) {
    try {
      if (storage) storage.setItem('address-sorter:' + key, value);
    } catch (e) {
      /* ignore */
    }
  }

  function userError(message) {
    const e = new Error(message);
    e.userMessage = message;
    return e;
  }
  const isAbort = (e) => e && e.name === 'AbortError';
  // Lets the browser repaint (e.g. the progress text) before heavy work.
  const nextFrame = () => new Promise((r) => setTimeout(r, 50));

  function columnLetter(i) {
    let s = '';
    i++;
    while (i > 0) {
      const m = (i - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }

  function showError(where, message) {
    const box = $('#' + where + '-error');
    box.textContent = message || '';
    box.hidden = !message;
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const geocoder = AS.geocoder.createGeocoder({ storage });

  const state = {
    fileName: '',
    sheets: [], // [{name, rows: string[][], raw: any[][]}]
    sheetIndex: 0,
    hasHeader: true,
    mapping: A.emptyMapping(),
    options: null,
    stops: [],
    skippedRows: [], // data rows with no address at all
    fixes: new Map(), // row id -> {origQuery, query?, lat?, lon?, keep?}
    startPoint: null,
    route: null,
    walkingPath: null,
    networkNote: '',
    lookupErrors: 0,
    units: getPref('units', ''),
    abort: null,
    dirty: false,
    placing: null,
    map: null,
    mapLayer: null,
    markers: new Map(),
  };

  const STEPS = ['upload', 'configure', 'progress', 'results'];
  function showStep(name) {
    const changed = $('#step-' + name).hidden;
    for (const s of STEPS) $('#step-' + s).hidden = s !== name;
    if (changed) window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------------------
  // Step 1: reading input
  // ---------------------------------------------------------------------------

  /** Keeps text and raw cell values aligned while dropping blank rows. */
  function tidySheet(textRows, rawRows) {
    const rows = [];
    const raw = [];
    let width = 0;
    textRows.forEach((r, i) => {
      const cells = (r || []).map((c) => (c === null || c === undefined ? '' : String(c).trim()));
      if (!cells.some((c) => c !== '')) return;
      rows.push(cells);
      raw.push((rawRows && rawRows[i]) || cells);
      width = Math.max(width, cells.length);
    });
    for (const r of rows) while (r.length < width) r.push('');
    while (width > 0 && rows.every((r) => r[width - 1] === '')) {
      width--;
      rows.forEach((r) => r.pop());
    }
    return { rows, raw };
  }

  function decodeText(buffer) {
    const utf8 = new TextDecoder('utf-8').decode(buffer);
    if (!utf8.includes('\uFFFD')) return utf8;
    try {
      return new TextDecoder('windows-1252').decode(buffer); // older Excel CSV exports
    } catch (e) {
      return utf8;
    }
  }

  async function loadFile(file) {
    showError('upload', '');
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    try {
      const buffer = await file.arrayBuffer();
      let sheets;
      if (['csv', 'tsv', 'txt'].includes(ext)) {
        const { rows } = tidySheet(A.parseDelimited(decodeText(buffer)));
        sheets = [{ name: file.name, rows, raw: rows }];
      } else {
        if (!window.XLSX) {
          throw userError(
            "The spreadsheet reader couldn't be loaded (are you offline?). Save the file as CSV and try again, or check your internet connection."
          );
        }
        const wb = window.XLSX.read(new Uint8Array(buffer), { type: 'array' });
        sheets = wb.SheetNames.map((name) => {
          const ws = wb.Sheets[name];
          const text = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true });
          const raw = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true });
          return Object.assign({ name }, tidySheet(text, raw));
        });
      }
      useData(file.name, sheets);
    } catch (e) {
      if (!e.userMessage) console.error(e);
      showError('upload', e.userMessage || "Sorry, that file couldn't be read. Is it a spreadsheet (.xlsx, .xls, .ods or .csv)?");
    }
  }

  function loadPasted(text) {
    showError('upload', '');
    const { rows } = tidySheet(A.parseDelimited(text));
    if (!rows.length) {
      showError('upload', 'Paste at least one address first.');
      return;
    }
    useData('Pasted addresses', [{ name: 'Pasted', rows, raw: rows }]);
  }

  function useData(fileName, sheets) {
    const usable = sheets.filter((s) => s.rows.length);
    if (!usable.length) {
      showError('upload', 'That file looks empty.');
      return;
    }
    state.fileName = fileName;
    state.sheets = usable;
    state.fixes = new Map();
    // Workbooks often have a notes or cover sheet: start on the biggest one.
    let biggest = 0;
    usable.forEach((s, i) => {
      if (s.rows.length > usable[biggest].rows.length) biggest = i;
    });
    selectSheet(biggest);
    showStep('configure');
  }

  function selectSheet(index) {
    state.sheetIndex = index;
    const sheet = state.sheets[index];
    state.hasHeader = A.detectHeaderRow(sheet.rows);
    detectMapping();
    renderConfigure();
  }

  function currentSheet() {
    return state.sheets[state.sheetIndex];
  }

  function headers() {
    const sheet = currentSheet();
    const width = sheet.rows[0] ? sheet.rows[0].length : 0;
    const out = [];
    for (let i = 0; i < width; i++) {
      const name = state.hasHeader ? sheet.rows[0][i] : '';
      out.push(name || 'Column ' + columnLetter(i));
    }
    return out;
  }

  function dataRows() {
    const sheet = currentSheet();
    const skip = state.hasHeader ? 1 : 0;
    return sheet.rows.slice(skip).map((text, i) => ({ id: i, text, raw: sheet.raw[i + skip] || text }));
  }

  function detectMapping() {
    state.mapping = A.detectColumns(headers(), dataRows().map((r) => r.text));
  }

  // ---------------------------------------------------------------------------
  // Step 2: configure
  // ---------------------------------------------------------------------------

  function renderConfigure() {
    const sheet = currentSheet();
    const count = sheet.rows.length - (state.hasHeader ? 1 : 0);
    $('#file-summary').textContent = state.fileName + ' — ' + count + (count === 1 ? ' row' : ' rows');

    const sheetRow = $('#sheet-row');
    sheetRow.hidden = state.sheets.length < 2;
    const select = $('#sheet-select');
    select.replaceChildren(...state.sheets.map((s, i) => el('option', { value: i, selected: i === state.sheetIndex }, s.name)));

    $('#has-header').checked = state.hasHeader;
    renderMapping();
    renderPreview();
  }

  function renderMapping() {
    const hs = headers();
    const grid = $('#mapping');
    grid.replaceChildren(
      ...ROLES.map((role) => {
        const id = 'map-' + role.key;
        const select = el(
          'select',
          { id, 'data-role': role.key },
          el('option', { value: '' }, '— none —'),
          hs.map((h, i) => el('option', { value: i, selected: state.mapping[role.key] === i }, h))
        );
        select.addEventListener('change', () => {
          state.mapping[role.key] = select.value === '' ? null : Number(select.value);
          renderPreview();
        });
        return el('div', { class: 'mapping-item' + (state.mapping[role.key] !== null ? ' is-set' : '') }, el('label', { for: id }, role.label), select);
      })
    );
  }

  function previewQuery(row, defaultLocality) {
    const m = state.mapping;
    const a = A.buildAddress(row.text, m, { areaHint: $('#area-hint').value, defaultLocality });
    const lat = m.lat !== null ? A.parseCoordinate(row.raw[m.lat], 'lat') : null;
    const lon = m.lon !== null ? A.parseCoordinate(row.raw[m.lon], 'lon') : null;
    if (lat !== null && lon !== null) return lat.toFixed(5) + ', ' + lon.toFixed(5) + ' (from your file)';
    return a.empty ? '' : a.query;
  }

  function renderPreview() {
    for (const item of $$('#mapping .mapping-item')) {
      const role = $('select', item).dataset.role;
      item.classList.toggle('is-set', state.mapping[role] !== null);
    }
    const hs = headers();
    const rows = dataRows();
    const sample = rows.slice(0, 6);
    const defaultLocality = defaultLocalityFor(rows);
    const used = new Set(Object.values(state.mapping).filter((v) => v !== null));
    const table = $('#preview');
    table.replaceChildren(
      el(
        'thead',
        null,
        el('tr', null, hs.map((h, i) => el('th', { class: used.has(i) ? 'is-used' : '' }, h)), el('th', { class: 'lookup-col' }, 'We will look up'))
      ),
      el(
        'tbody',
        null,
        sample.map((r) =>
          el(
            'tr',
            null,
            r.text.map((c, i) => el('td', { class: used.has(i) ? 'is-used' : '' }, c)),
            el('td', { class: 'lookup-col' }, previewQuery(r, defaultLocality) || el('span', { class: 'muted' }, '(no address)'))
          )
        )
      )
    );
    if (rows.length > sample.length) {
      table.append(el('tfoot', null, el('tr', null, el('td', { colspan: hs.length + 1, class: 'muted' }, '…and ' + (rows.length - sample.length) + ' more'))));
    }
  }

  function defaultLocalityFor(rows) {
    if ($('#area-hint').value.trim()) return '';
    const built = rows.map((r) => A.buildAddress(r.text, state.mapping, {}));
    return A.inferDefaultLocality(built);
  }

  function readOptions() {
    return {
      startMode: $('#start-mode').value,
      startAddress: $('#start-address').value.trim(),
      loop: $('#finish-mode').value === 'loop',
      avoidCrossing: $('#crossing-mode').value === 'avoid',
      provider: $('#provider').value,
      useNetwork: $('#use-network').checked,
      areaHint: $('#area-hint').value.trim(),
    };
  }

  // ---------------------------------------------------------------------------
  // Running: lookups and optimisation
  // ---------------------------------------------------------------------------

  function setProgress(text, fraction, detail) {
    $('#progress-text').textContent = text;
    $('#progress-bar').style.width = Math.round(Math.max(0, Math.min(1, fraction || 0)) * 100) + '%';
    if (detail !== undefined) $('#progress-detail').textContent = detail;
  }

  function buildStops(options) {
    const rows = dataRows();
    const m = state.mapping;
    const defaultLocality = options.areaHint ? '' : defaultLocalityFor(rows);
    state.stops = [];
    state.skippedRows = [];
    for (const row of rows) {
      const a = A.buildAddress(row.text, m, { areaHint: options.areaHint, defaultLocality });
      const lat = m.lat !== null ? A.parseCoordinate(row.raw[m.lat], 'lat') : null;
      const lon = m.lon !== null ? A.parseCoordinate(row.raw[m.lon], 'lon') : null;
      const hasCoords = lat !== null && lon !== null && !(lat === 0 && lon === 0);
      if (a.empty && !hasCoords) {
        state.skippedRows.push(row);
        continue;
      }
      const stop = {
        id: row.id,
        row,
        display: a.empty ? lat.toFixed(5) + ', ' + lon.toFixed(5) : a.display,
        query: a.query,
        origQuery: a.query,
        street: a.street,
        streetKey: a.streetKey,
        number: a.number,
        isUS: a.isUS,
        lat: hasCoords ? lat : null,
        lon: hasCoords ? lon : null,
        precision: hasCoords ? 'given' : null,
        status: hasCoords ? 'located' : 'pending',
        matched: '',
        keep: false,
      };
      const fix = state.fixes.get(row.id);
      if (fix && fix.origQuery === a.query) {
        if (fix.query) stop.query = fix.query;
        if (fix.lat !== undefined) Object.assign(stop, { lat: fix.lat, lon: fix.lon, precision: 'manual', status: 'located' });
        if (fix.keep) stop.keep = true;
      }
      state.stops.push(stop);
    }
  }

  function rememberFix(stop, patch) {
    const fix = state.fixes.get(stop.id) || { origQuery: stop.origQuery };
    state.fixes.set(stop.id, Object.assign(fix, patch));
  }

  function startQueryFor(text, options) {
    let query = text;
    if (!A.hasLocality(query)) {
      const hint = options.areaHint || defaultLocalityFor(dataRows());
      if (hint) query += ', ' + hint;
    }
    return { query, isUS: A.looksUS(query) || state.stops.some((s) => s.isUS) };
  }

  function currentLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(userError("This browser can't share your location. Choose another start option."));
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Your location' }),
        () => reject(userError("Couldn't get your location. Allow location access, or choose another start option.")),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 }
      );
    });
  }

  async function geocodePending(options, signal) {
    const pending = state.stops.filter((s) => s.lat === null);
    const items = new Map();
    for (const s of pending) if (!items.has(s.query)) items.set(s.query, { query: s.query, isUS: s.isUS });
    let start = null;
    if (options.startMode === 'address') {
      start = startQueryFor(options.startAddress, options);
      if (!items.has(start.query)) items.set(start.query, start);
    }
    if (!items.size) return;

    const slowNote =
      items.size > 15
        ? 'Each address is looked up online. Results are remembered on this device, so running the same list again is instant.'
        : '';
    setProgress('Finding your addresses on the map…', 0, slowNote);
    const { results, errors, lastError } = await geocoder.geocodeAll(Array.from(items.values()), {
      provider: options.provider,
      signal,
      onProgress: ({ done, total }) => setProgress('Finding your addresses on the map… ' + done + ' of ' + total, total ? done / total : 1),
    });

    let found = 0;
    for (const s of pending) {
      const r = results.get(s.query);
      if (r) {
        Object.assign(s, { lat: r.lat, lon: r.lon, precision: r.precision, matched: r.matched, status: 'located' });
        found++;
      } else {
        s.status = 'notfound';
      }
    }
    state.lookupErrors = errors;
    if (pending.length && !found && errors) {
      throw userError(
        "Couldn't reach the address lookup service. Check your internet connection and try again." +
          (lastError && lastError.message ? ' (' + lastError.message + ')' : '')
      );
    }
    if (start) {
      const r = results.get(start.query);
      if (!r) throw userError('Couldn\'t find the starting address "' + options.startAddress + '". Check it, or choose another start option.');
      state.startPoint = { lat: r.lat, lon: r.lon, label: options.startAddress };
    }
  }

  /**
   * Places addresses that weren't found, or were only matched to the street,
   * between their neighbours' house numbers on the same street.
   */
  function fillGaps() {
    const byStreet = new Map();
    for (const s of state.stops) {
      if (s.status !== 'located' || !s.streetKey || s.number === null || s.precision === 'street' || s.precision === 'estimated') continue;
      if (!byStreet.has(s.streetKey)) byStreet.set(s.streetKey, []);
      byStreet.get(s.streetKey).push({ number: s.number, lat: s.lat, lon: s.lon });
    }
    for (const s of state.stops) {
      const fuzzy = s.status === 'notfound' || (s.status === 'located' && s.precision === 'street');
      if (!fuzzy || !s.streetKey || s.number === null) continue;
      const est = G.estimateFromNeighbours(s.number, byStreet.get(s.streetKey) || []);
      if (est) Object.assign(s, { lat: est.lat, lon: est.lon, precision: 'estimated', status: 'located' });
    }
  }

  /** Sets aside addresses that landed far from everything else. */
  function flagOutliers() {
    const located = state.stops.filter((s) => s.status === 'located');
    for (const i of G.findOutliers(located)) {
      const s = located[i];
      if (s.precision === 'given' || s.precision === 'manual' || s.keep) continue;
      s.status = 'outlier';
    }
  }

  const routable = (s) => s.lat !== null && (s.status === 'located' || (s.status === 'outlier' && s.keep));

  async function runSort() {
    showError('configure', '');
    const m = state.mapping;
    if (m.address === null && (m.lat === null || m.lon === null)) {
      showError('configure', 'Choose the column that holds the addresses (or both latitude and longitude).');
      return;
    }
    const options = readOptions();
    if (options.startMode === 'address' && !options.startAddress) {
      showError('configure', 'Type the address you want to start from.');
      return;
    }
    state.options = options;
    const ctrl = new AbortController();
    state.abort = ctrl;
    showStep('progress');
    setProgress('Reading your addresses…', 0, '');
    try {
      buildStops(options);
      if (!state.stops.length) throw userError('No addresses were found in the column you picked.');
      state.startPoint = null;
      if (options.startMode === 'here') {
        setProgress('Getting your location…', 0);
        state.startPoint = await currentLocation();
      }
      await geocodePending(options, ctrl.signal);
      fillGaps();
      flagOutliers();
      if (!state.stops.some(routable)) {
        throw userError(
          "None of the addresses could be found on the map. Check that the right column is picked as Address, and add the town or ZIP code under \"Town or ZIP to search in\"."
        );
      }
      await planAndRender(ctrl.signal);
    } catch (e) {
      showStep('configure');
      if (!isAbort(e)) {
        console.error(e);
        showError('configure', e.userMessage || 'Something went wrong: ' + e.message);
      }
    } finally {
      state.abort = null;
    }
  }

  function routePoints() {
    const r = state.route;
    const pts = r.stops.map((s) => ({ lat: s.lat, lon: s.lon }));
    if (state.startPoint) pts.unshift(state.startPoint);
    if (state.options.loop && pts.length > 1) pts.push(pts[0]);
    return pts;
  }

  async function planAndRender(signal) {
    const options = state.options;
    const active = state.stops.filter(routable);
    state.networkNote = '';
    state.walkingPath = null;
    let matrix = null;

    if (options.useNetwork && active.length > 1) {
      const points = active.map((s) => ({ lat: s.lat, lon: s.lon }));
      if (state.startPoint) points.push(state.startPoint);
      if (points.length > AS.walking.MAX_POINTS) {
        state.networkNote = 'Real walking paths work for up to ' + AS.walking.MAX_POINTS + ' stops, so straight-line distances were used.';
      } else {
        const label = 'Measuring walking distances along streets…';
        setProgress(label, 0, '');
        try {
          matrix = await AS.walking.fetchWalkingMatrix(points, {
            signal,
            onProgress: ({ done, total }) => setProgress(label, done / total),
          });
        } catch (e) {
          if (isAbort(e)) throw e;
          console.warn(e);
          state.networkNote = "The walking-path service couldn't be reached, so straight-line distances were used.";
        }
      }
    }

    setProgress('Finding the best walking order…', 1, '');
    await nextFrame();
    const start = state.startPoint || (options.startMode === 'first' ? 'first' : 'best');
    const plan = AS.planner.planRoute(
      active.map((s) => ({
        lat: s.lat,
        lon: s.lon,
        street: s.streetKey,
        number: s.number,
        approx: s.precision === 'street' || s.precision === 'estimated',
      })),
      {
        start,
        loop: options.loop,
        avoidCrossing: options.avoidCrossing,
        matrix,
        timeLimitMs: Math.min(2500, 400 + 4 * active.length),
      }
    );
    state.route = {
      stops: plan.order.map((i) => active[i]),
      legs: plan.legs,
      returnLeg: plan.returnLeg,
      total: plan.total,
      network: !!matrix,
    };

    if (matrix) {
      try {
        setProgress('Drawing the walking path…', 1);
        state.walkingPath = (await AS.walking.fetchWalkingPath(routePoints(), { signal })).path;
      } catch (e) {
        if (isAbort(e)) throw e;
        state.walkingPath = null;
      }
    }

    if (!state.units) state.units = active.filter((s) => s.isUS).length >= active.length / 2 ? 'imperial' : 'metric';
    state.dirty = false;
    state.placing = null;
    showStep('results');
    renderResults({ fit: true });
  }

  async function reoptimize() {
    const btn = $('#reoptimize-go');
    btn.disabled = true;
    btn.textContent = 'Updating…';
    try {
      const ctrl = new AbortController();
      state.abort = ctrl;
      if (state.options.useNetwork) showStep('progress');
      await planAndRender(ctrl.signal);
    } catch (e) {
      if (!isAbort(e)) console.error(e);
      showStep('results');
      renderResults();
    } finally {
      state.abort = null;
      btn.disabled = false;
      btn.textContent = 'Update the route';
    }
  }

  // ---------------------------------------------------------------------------
  // Step 3: results
  // ---------------------------------------------------------------------------

  const fmt = (m) => G.formatDistance(m, state.units);

  function renderResults(opts) {
    for (const b of $$('.units-toggle button')) b.classList.toggle('is-active', b.dataset.units === state.units);
    renderSummary();
    renderAttention();
    renderMap(!!(opts && opts.fit));
    renderNavLinks();
    renderTable();
    $('#update-bar').hidden = !state.dirty;
  }

  function notInRoute() {
    const inRoute = new Set(state.route.stops);
    return state.stops.filter((s) => !inRoute.has(s));
  }

  function renderSummary() {
    const r = state.route;
    const walkMeters = r.network ? r.total : r.total * STRAIGHT_LINE_DETOUR;
    const box = $('#summary');
    const stat = (value, label) => el('div', { class: 'stat' }, el('span', { class: 'stat-value' }, value), el('span', { class: 'stat-label' }, label));
    const missing = notInRoute().length;
    const notes = [];
    if (r.stops.length > 1) {
      notes.push(
        r.network
          ? 'Distances follow real walking paths.'
          : 'Measured in straight lines between stops; the walking estimate adds a bit for following streets.'
      );
      notes.push('Time spent at each stop is not included.');
    }
    if (state.networkNote) notes.push(state.networkNote);
    box.replaceChildren(
      ...[
        el(
          'div',
          { class: 'stats' },
          stat(String(r.stops.length), r.stops.length === 1 ? 'stop' : 'stops'),
          r.stops.length > 1 && stat((r.network ? '' : '≈ ') + fmt(walkMeters), 'walking distance'),
          r.stops.length > 1 && stat('≈ ' + G.formatDuration(walkMeters / WALK_SPEED_MPS), 'walking time')
        ),
        notes.length && el('p', { class: 'muted small' }, notes.join(' ')),
        missing &&
          el('p', { class: 'warn-text' }, missing + (missing === 1 ? " address isn't" : " addresses aren't") + ' in the route yet — see below.'),
      ].filter(Boolean)
    );
  }

  function stopLabel(stop) {
    return stop.display || stop.query;
  }

  function attentionItem(stop, message, actions) {
    return el(
      'li',
      { class: 'attention-item', 'data-stop': stop.id },
      el('div', { class: 'attention-text' }, el('strong', null, stopLabel(stop)), el('span', { class: 'muted' }, message)),
      el('div', { class: 'attention-actions' }, actions)
    );
  }

  function retryControls(stop) {
    const input = el('input', { type: 'text', value: stop.query, 'aria-label': 'Address to look up' });
    const status = el('span', { class: 'retry-status muted' });
    const button = el('button', { type: 'button', class: 'btn btn-small' }, 'Search again');
    button.addEventListener('click', async () => {
      const query = input.value.trim();
      if (!query) return;
      button.disabled = true;
      status.textContent = 'Searching…';
      try {
        const { results } = await geocoder.geocodeAll([{ query, isUS: A.looksUS(query) || stop.isUS }], { provider: state.options.provider });
        const r = results.get(query);
        if (!r) {
          status.textContent = 'Still not found. Try adding the town or ZIP, or place it on the map.';
          return;
        }
        Object.assign(stop, { query, lat: r.lat, lon: r.lon, precision: r.precision, matched: r.matched, status: 'located', keep: true });
        rememberFix(stop, { query, keep: true });
        markDirty();
      } catch (e) {
        status.textContent = "Couldn't search right now: " + e.message;
      } finally {
        button.disabled = false;
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') button.click();
    });
    return el('div', { class: 'retry' }, input, button, placeButton(stop), status);
  }

  function placeButton(stop) {
    return el(
      'button',
      {
        type: 'button',
        class: 'btn btn-small btn-quiet',
        onclick: () => startPlacing(stop),
        disabled: !window.L,
      },
      'Place on map'
    );
  }

  function renderAttention() {
    const box = $('#attention');
    const notFound = state.stops.filter((s) => s.status === 'notfound' && s.lat === null);
    const outliers = state.stops.filter((s) => s.status === 'outlier' && !s.keep);
    const fuzzy = state.route.stops.filter((s) => s.precision === 'street' || s.precision === 'estimated');
    const parts = [];

    if (notFound.length) {
      parts.push(
        el('h3', null, notFound.length === 1 ? "1 address couldn't be found" : notFound.length + " addresses couldn't be found"),
        el('p', { class: 'hint' }, 'Fix the spelling or add the town, then search again — or place the pin on the map yourself.'),
        el('ul', { class: 'attention-list' }, notFound.map((s) => attentionItem(s, '', retryControls(s))))
      );
    }
    if (outliers.length) {
      parts.push(
        el('h3', null, outliers.length === 1 ? '1 address looks far away from the rest' : outliers.length + ' addresses look far away from the rest'),
        el('p', { class: 'hint' }, "These were left out because the match is probably in the wrong town. Check them, or keep them if they're right."),
        el(
          'ul',
          { class: 'attention-list' },
          outliers.map((s) =>
            attentionItem(
              s,
              s.matched ? 'Matched to: ' + s.matched : '',
              [
                retryControls(s),
                el(
                  'button',
                  {
                    type: 'button',
                    class: 'btn btn-small btn-quiet',
                    onclick: () => {
                      s.keep = true;
                      rememberFix(s, { keep: true });
                      markDirty();
                    },
                  },
                  'Keep it'
                ),
              ]
            )
          )
        )
      );
    }
    if (fuzzy.length) {
      parts.push(
        el(
          'details',
          { class: 'fuzzy' },
          el('summary', null, fuzzy.length + (fuzzy.length === 1 ? ' stop has' : ' stops have') + ' an approximate position'),
          el('p', { class: 'hint' }, 'Their place in the order is based on the street and house number. Drag the pin on the map if you know better.'),
          el(
            'ul',
            { class: 'attention-list' },
            fuzzy.map((s) => attentionItem(s, PRECISION[s.precision].help, placeButton(s)))
          )
        )
      );
    }
    box.replaceChildren(...parts);
    box.hidden = !parts.length;
  }

  function markDirty() {
    state.dirty = true;
    renderAttention();
    renderMap();
    $('#update-bar').hidden = false;
  }

  // ---- map ------------------------------------------------------------------

  function ensureMap() {
    if (!window.L) {
      $('#map').hidden = true;
      $('#map-help').hidden = true;
      $('#map-unavailable').hidden = false;
      return null;
    }
    if (!state.map) {
      const map = window.L.map('map', { scrollWheelZoom: false });
      window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);
      map.on('click', onMapClick);
      map.on('focus', () => map.scrollWheelZoom.enable());
      map.on('blur', () => map.scrollWheelZoom.disable());
      state.map = map;
      state.mapLayer = window.L.layerGroup().addTo(map);
    }
    return state.map;
  }

  function pinIcon(text, cls) {
    return window.L.divIcon({
      className: 'pin ' + (cls || ''),
      html: '<span>' + text + '</span>',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      popupAnchor: [0, -14],
    });
  }

  function popupContent(stop, n) {
    const p = PRECISION[stop.precision] || {};
    return el(
      'div',
      { class: 'popup' },
      el('strong', null, (n ? n + '. ' : '') + stopLabel(stop)),
      p.label ? el('div', { class: 'muted' }, p.label + (p.help ? ' — ' + p.help : '')) : null,
      el('a', { href: mapsSearchUrl(stop), target: '_blank', rel: 'noopener' }, 'Open in Google Maps')
    );
  }

  /** Draws the route and pins. `fit` zooms the map to show everything. */
  function renderMap(fit) {
    const map = ensureMap();
    if (!map) return;
    const layer = state.mapLayer;
    layer.clearLayers();
    state.markers = new Map();
    const r = state.route;
    const bounds = [];

    const line = state.walkingPath && !state.dirty ? state.walkingPath : routePoints().map((p) => [p.lat, p.lon]);
    if (line.length > 1) window.L.polyline(line, { color: '#1a7f64', weight: 4, opacity: 0.8, interactive: false }).addTo(layer);

    if (state.startPoint) {
      const sp = state.startPoint;
      window.L.marker([sp.lat, sp.lon], { icon: pinIcon('S', 'pin-start'), title: 'Start', zIndexOffset: 1000 })
        .bindPopup(el('div', { class: 'popup' }, el('strong', null, 'Start'), el('div', null, sp.label || '')))
        .addTo(layer);
      bounds.push([sp.lat, sp.lon]);
    }

    const addMarker = (stop, text, cls) => {
      const marker = window.L.marker([stop.lat, stop.lon], { icon: pinIcon(text, cls), draggable: true, title: stopLabel(stop) });
      marker.bindPopup(() => popupContent(stop, typeof text === 'number' ? text : null));
      marker.on('dragend', () => {
        const ll = marker.getLatLng();
        Object.assign(stop, { lat: ll.lat, lon: ll.lng, precision: 'manual', status: 'located', keep: true });
        rememberFix(stop, { lat: ll.lat, lon: ll.lng, keep: true });
        markDirty();
      });
      marker.addTo(layer);
      state.markers.set(stop.id, marker);
      bounds.push([stop.lat, stop.lon]);
    };

    r.stops.forEach((stop, i) => {
      const cls = (PRECISION[stop.precision] || {}).cls === 'warn' ? 'pin-warn' : '';
      addMarker(stop, i + 1, cls);
    });
    // Stops fixed since the last optimisation: shown, but not numbered yet.
    for (const stop of state.stops) {
      if (!state.markers.has(stop.id) && routable(stop)) addMarker(stop, '?', 'pin-new');
    }

    setTimeout(() => {
      map.invalidateSize();
      if (!fit && state.mapFitted) return;
      state.mapFitted = true;
      if (bounds.length === 1) map.setView(bounds[0], 17);
      else if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 18 });
      else map.setView([20, 0], 2);
    }, 0);

    const banner = $('#placing-banner');
    if (banner) banner.remove();
    if (state.placing) {
      const stop = state.placing;
      $('#map').before(
        el(
          'div',
          { id: 'placing-banner', class: 'placing-banner' },
          el('span', null, 'Click the map where ', el('strong', null, stopLabel(stop)), ' is.'),
          el('button', { type: 'button', class: 'btn btn-small btn-quiet', onclick: () => stopPlacing() }, 'Cancel')
        )
      );
    }
    $('#map').classList.toggle('is-placing', !!state.placing);
  }

  function startPlacing(stop) {
    state.placing = stop;
    renderMap();
    $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function stopPlacing() {
    state.placing = null;
    renderMap();
  }

  function onMapClick(e) {
    if (!state.placing) return;
    const stop = state.placing;
    state.placing = null;
    Object.assign(stop, { lat: e.latlng.lat, lon: e.latlng.lng, precision: 'manual', status: 'located', keep: true });
    rememberFix(stop, { lat: e.latlng.lat, lon: e.latlng.lng, keep: true });
    markDirty();
  }

  function focusStop(stop) {
    const marker = state.markers.get(stop.id);
    if (!marker || !state.map) return;
    $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
    state.map.setView(marker.getLatLng(), Math.max(state.map.getZoom(), 17));
    marker.openPopup();
  }

  // ---- links ----------------------------------------------------------------

  /** Text Google Maps should use for a stop: the address when we looked it up, else the pin. */
  function mapsPlace(p) {
    if (!p.query || p.precision === 'manual' || p.precision === 'given') return p.lat.toFixed(6) + ',' + p.lon.toFixed(6);
    return p.query;
  }

  function mapsSearchUrl(stop) {
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(mapsPlace(stop));
  }

  function renderNavLinks() {
    const card = $('#nav-card');
    const pts = state.route.stops.map((s, i) => ({ place: mapsPlace(s), n: i + 1 }));
    if (state.startPoint) pts.unshift({ place: state.startPoint.lat.toFixed(6) + ',' + state.startPoint.lon.toFixed(6), n: 'Start' });
    if (state.options.loop && pts.length > 1) pts.push({ place: pts[0].place, n: 'Start' });
    if (pts.length < 2) {
      card.hidden = true;
      return;
    }
    const links = [];
    for (let i = 0; i < pts.length - 1; i += NAV_CHUNK - 1) {
      const chunk = pts.slice(i, i + NAV_CHUNK);
      if (chunk.length < 2) break;
      const origin = chunk[0];
      const dest = chunk[chunk.length - 1];
      const waypoints = chunk.slice(1, -1).map((p) => p.place).join('|');
      const url =
        'https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=' + encodeURIComponent(origin.place) +
        '&destination=' + encodeURIComponent(dest.place) +
        (waypoints ? '&waypoints=' + encodeURIComponent(waypoints) : '');
      const label = (origin.n === 'Start' ? 'Start' : 'Stop ' + origin.n) + ' → ' + (dest.n === 'Start' ? 'back to start' : 'stop ' + dest.n);
      links.push(el('a', { class: 'btn btn-small', href: url, target: '_blank', rel: 'noopener' }, label));
    }
    $('#nav-links').replaceChildren(...links);
    card.hidden = false;
  }

  // ---- table ----------------------------------------------------------------

  /** Original columns that are not part of the address, e.g. names or notes. */
  function extraColumns() {
    const used = new Set(Object.values(state.mapping).filter((v) => v !== null));
    return headers()
      .map((h, i) => ({ h, i }))
      .filter((c) => !used.has(c.i) && dataRows().some((r) => r.text[c.i]))
      .slice(0, 3);
  }

  function badge(stop) {
    if (stop.status === 'notfound' && stop.lat === null) return el('span', { class: 'badge badge-bad' }, 'Not found');
    if (stop.status === 'outlier' && !stop.keep) return el('span', { class: 'badge badge-bad' }, 'Far away?');
    const p = PRECISION[stop.precision];
    if (!p || p.cls === 'ok') return null;
    return el('span', { class: 'badge badge-warn', title: p.help || '' }, p.label);
  }

  /** On phones the extra columns are folded into the address cell. */
  function extraInline(extras, row) {
    const values = extras.map((c) => row.text[c.i]).filter(Boolean);
    return values.length ? el('div', { class: 'extra-inline muted' }, values.join(' · ')) : null;
  }

  function renderTable() {
    const extras = extraColumns();
    const r = state.route;
    const head = el(
      'tr',
      null,
      el('th', { class: 'num' }, '#'),
      el('th', { class: 'print-only check-col' }, '✓'),
      extras.map((c) => el('th', { class: 'extra' }, c.h)),
      el('th', null, 'Address'),
      el('th', { class: 'dist' }, 'From previous'),
      el('th', { class: 'no-print' }, '')
    );
    const body = el('tbody');
    const colCount = 4 + extras.length + 1;

    if (state.startPoint) {
      body.append(
        el(
          'tr',
          { class: 'start-row' },
          el('td', { class: 'num' }, 'S'),
          el('td', { class: 'print-only check-col' }),
          extras.map(() => el('td', { class: 'extra' })),
          el('td', null, 'Start: ' + (state.startPoint.label || '')),
          el('td', { class: 'dist' }),
          el('td', { class: 'no-print' })
        )
      );
    }
    r.stops.forEach((stop, i) => {
      const tr = el(
        'tr',
        { tabindex: 0, 'data-stop': stop.id },
        el('td', { class: 'num' }, String(i + 1)),
        el('td', { class: 'print-only check-col' }, el('span', { class: 'box' })),
        extras.map((c) => el('td', { class: 'extra' }, stop.row.text[c.i] || '')),
        el('td', null, stopLabel(stop), ' ', badge(stop), extraInline(extras, stop.row)),
        el('td', { class: 'dist' }, i === 0 && !state.startPoint ? '—' : fmt(r.legs[i])),
        el('td', { class: 'no-print' }, el('a', { href: mapsSearchUrl(stop), target: '_blank', rel: 'noopener', title: 'Open in Google Maps' }, 'Map'))
      );
      tr.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        focusStop(stop);
      });
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') focusStop(stop);
      });
      body.append(tr);
    });
    if (state.options.loop && r.stops.length > 1) {
      body.append(
        el(
          'tr',
          { class: 'start-row' },
          el('td', { class: 'num' }, '↩'),
          el('td', { class: 'print-only check-col' }),
          extras.map(() => el('td', { class: 'extra' })),
          el('td', null, 'Back to start'),
          el('td', { class: 'dist' }, fmt(r.returnLeg)),
          el('td', { class: 'no-print' })
        )
      );
    }

    const missing = notInRoute();
    const table = $('#results-table');
    table.replaceChildren(el('thead', null, head), body);
    if (missing.length) {
      table.append(
        el(
          'tbody',
          { class: 'missing' },
          el('tr', null, el('th', { colspan: colCount, class: 'section-head' }, 'Not in the route')),
          missing.map((stop) =>
            el(
              'tr',
              null,
              el('td', { class: 'num' }, '–'),
              el('td', { class: 'print-only check-col' }),
              extras.map((c) => el('td', { class: 'extra' }, stop.row.text[c.i] || '')),
              el('td', null, stopLabel(stop), ' ', badge(stop) || el('span', { class: 'badge badge-warn' }, 'Not yet routed'), extraInline(extras, stop.row)),
              el('td', { class: 'dist' }),
              el('td', { class: 'no-print' })
            )
          )
        )
      );
    }
  }

  // ---- export ---------------------------------------------------------------

  function noteFor(stop, inRoute) {
    if (!inRoute) {
      if (stop.status === 'notfound' && stop.lat === null) return 'Not found';
      if (stop.status === 'outlier' && !stop.keep) return 'Left out: far from the other addresses';
      return 'Not routed yet';
    }
    return (PRECISION[stop.precision] || {}).label || '';
  }

  /**
   * Builds the export as rows of cells: the original columns in walking
   * order, plus stop number, coordinates and distances. `typed` turns
   * number-like cells into real numbers (for Excel).
   */
  function exportRows(typed) {
    const m = state.mapping;
    const hasCoordColumns = m.lat !== null && m.lon !== null;
    const coord = (v) => (v === null || v === undefined ? '' : typed ? Number(v.toFixed(6)) : v.toFixed(6));
    const value = (text, raw, col) => {
      if (!typed || col === m.zip) return text;
      if (typeof raw === 'number' && String(raw) === text) return raw;
      // Plain numbers (no leading zeros, which matter in codes) become numbers.
      if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(text)) return Number(text);
      return text;
    };
    const cellsFor = (row, stop) =>
      row.text.map((text, i) => {
        // Pins moved by hand replace the coordinates that came with the file.
        if (stop && hasCoordColumns && stop.precision === 'manual' && (i === m.lat || i === m.lon)) {
          return coord(i === m.lat ? stop.lat : stop.lon);
        }
        return value(text, row.raw[i], i);
      });
    const coordCells = (stop) => (hasCoordColumns ? [] : [coord(stop && stop.lat), coord(stop && stop.lon)]);

    const out = [['Stop'].concat(headers(), hasCoordColumns ? [] : ['Latitude', 'Longitude'], ['Location', 'Walk from previous', 'Walk so far'])];
    const r = state.route;
    let soFar = 0;
    r.stops.forEach((stop, i) => {
      soFar += r.legs[i];
      const first = i === 0 && !state.startPoint;
      out.push(
        [typed ? i + 1 : String(i + 1)].concat(cellsFor(stop.row, stop), coordCells(stop), [
          noteFor(stop, true),
          first ? '' : fmt(r.legs[i]),
          first ? '' : fmt(soFar),
        ])
      );
    });
    if (state.options.loop && r.stops.length > 1) {
      out.push(['Back to start'].concat(headers().map(() => ''), coordCells(null), ['', fmt(r.returnLeg), fmt(r.total)]));
    }
    for (const stop of notInRoute()) {
      out.push([''].concat(cellsFor(stop.row, stop), coordCells(stop), [noteFor(stop, false), '', '']));
    }
    for (const row of state.skippedRows) out.push([''].concat(cellsFor(row, null), coordCells(null), ['No address', '', '']));
    return out;
  }

  function exportName(ext) {
    const base = state.fileName.replace(/\.[^.]+$/, '') || 'addresses';
    return base + ' - walking order.' + ext;
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadCsv() {
    const csv = exportRows(false)
      .map((row) => row.map((c) => (/[",\n\r]/.test(c) ? '"' + String(c).replace(/"/g, '""') + '"' : c)).join(','))
      .join('\r\n');
    downloadBlob(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }), exportName('csv'));
  }

  function downloadXlsx() {
    if (!window.XLSX) {
      alert("The Excel writer couldn't be loaded (are you offline?). Downloading a CSV file instead — Excel opens those too.");
      downloadCsv();
      return;
    }
    const rows = exportRows(true);
    const ws = window.XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = rows[0].map((_, c) => ({ wch: Math.min(50, Math.max(6, ...rows.slice(0, 200).map((r) => String(r[c] === undefined ? '' : r[c]).length))) }));
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, 'Walking order');
    window.XLSX.writeFile(wb, exportName('xlsx'));
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  function restart() {
    if (state.abort) state.abort.abort();
    Object.assign(state, { sheets: [], stops: [], route: null, fixes: new Map(), startPoint: null, dirty: false, placing: null });
    $('#file-input').value = '';
    showError('upload', '');
    showStep('upload');
  }

  function init() {
    const input = $('#file-input');
    input.addEventListener('change', () => {
      if (input.files && input.files[0]) loadFile(input.files[0]);
    });
    const drop = $('#dropzone');
    ['dragenter', 'dragover'].forEach((t) =>
      drop.addEventListener(t, (e) => {
        e.preventDefault();
        drop.classList.add('is-over');
      })
    );
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('is-over')));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) loadFile(file);
    });
    // Dropping a file anywhere else should not navigate away from the page.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    $('#paste-go').addEventListener('click', () => loadPasted($('#paste-input').value));
    $('#sample-go').addEventListener('click', () => {
      const sample = AS.sample;
      const { rows } = tidySheet(sample.rows);
      useData(sample.fileName, [{ name: 'Sample', rows, raw: rows }]);
    });

    $('#sheet-select').addEventListener('change', (e) => selectSheet(Number(e.target.value)));
    $('#has-header').addEventListener('change', (e) => {
      state.hasHeader = e.target.checked;
      detectMapping();
      renderConfigure();
    });
    $('#area-hint').addEventListener('input', renderPreview);
    $('#start-mode').addEventListener('change', (e) => {
      const custom = e.target.value === 'address';
      $('#start-address').hidden = !custom;
      if (custom) $('#start-address').focus();
    });

    // Remember walk preferences between visits.
    for (const id of ['start-mode', 'finish-mode', 'crossing-mode', 'provider']) {
      const sel = $('#' + id);
      const saved = getPref(id, '');
      if (saved && $$('option', sel).some((o) => o.value === saved)) sel.value = saved;
      sel.addEventListener('change', () => setPref(id, sel.value));
    }
    $('#start-address').hidden = $('#start-mode').value !== 'address';

    $('#sort-go').addEventListener('click', runSort);
    $('#cancel-go').addEventListener('click', () => state.abort && state.abort.abort());
    $('#reoptimize-go').addEventListener('click', reoptimize);
    $('#download-xlsx').addEventListener('click', downloadXlsx);
    $('#download-csv').addEventListener('click', downloadCsv);
    $('#print-go').addEventListener('click', () => window.print());
    for (const b of $$('[data-action="restart"]')) b.addEventListener('click', restart);
    for (const b of $$('[data-action="back"]')) b.addEventListener('click', () => showStep('configure'));
    for (const b of $$('.units-toggle button')) {
      b.addEventListener('click', () => {
        state.units = b.dataset.units;
        setPref('units', state.units);
        renderResults();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.placing) stopPlacing();
    });
  }

  init();
})();
