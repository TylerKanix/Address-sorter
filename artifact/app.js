/*
 * Address Sorter, Claude artifact edition.
 *
 * Artifacts can't reach outside services, so this version doesn't look
 * addresses up itself. It sorts rows that already have coordinates, and for
 * US addresses it round-trips through the US Census batch geocoder website:
 * the page saves a file in the Census format, the person uploads it there,
 * and brings the results file back here.
 */
(function () {
  'use strict';

  const AS = window.AddressSorter;
  const A = AS.address;
  const G = AS.geo;

  const WALK_SPEED_MPS = 1.34; // about 3 mph
  const STRAIGHT_LINE_DETOUR = 1.2;
  const NAV_CHUNK = 10;
  const CENSUS_BATCH_URL = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch?form';
  const CENSUS_BATCH_LIMIT = 10000;
  const FULL_APP_URL = 'https://github.com/TylerKanix/Address-sorter';

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
    census: { label: 'US Census match', cls: 'ok' },
    estimated: { label: 'Estimated', cls: 'warn', help: 'No coordinates; placed between nearby house numbers on the same street.' },
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs) {
    const node = document.createElement(tag);
    setAttrs(node, attrs);
    for (let i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function svg(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    setAttrs(node, attrs);
    for (let i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function setAttrs(node, attrs) {
    if (!attrs) return;
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.setAttribute('class', v);
      else if (k === 'text') node.textContent = v;
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
  }
  function append(node, kids) {
    for (const c of [].concat(kids)) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : String(c));
    }
  }

  function getPref(key, fallback) {
    try {
      const v = window.localStorage.getItem('address-sorter:' + key);
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }
  function setPref(key, value) {
    try {
      window.localStorage.setItem('address-sorter:' + key, value);
    } catch (e) {
      /* preferences are only a convenience */
    }
  }

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

  function csvLine(cells) {
    return cells.map((c) => {
      const s = c === null || c === undefined ? '' : String(c);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const state = {
    fileName: '',
    sheets: [],
    sheetIndex: 0,
    hasHeader: true,
    mapping: A.emptyMapping(),
    census: new Map(), // sheet row index -> {lat, lon, matched}
    censusNote: null,
    options: null,
    stops: [],
    skippedRows: [],
    route: null,
    units: getPref('units', ''),
    example: false,
    selected: null,
    downloads: null,
    view: null,
  };

  function showSteps(names) {
    for (const s of ['upload', 'configure', 'results']) $('#step-' + s).hidden = !names.includes(s);
  }

  // ---------------------------------------------------------------------------
  // Step 1: reading input
  // ---------------------------------------------------------------------------

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
      return new TextDecoder('windows-1252').decode(buffer);
    } catch (e) {
      return utf8;
    }
  }

  async function readSheets(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const buffer = await file.arrayBuffer();
    if (['csv', 'tsv', 'txt'].includes(ext)) {
      const { rows } = tidySheet(A.parseDelimited(decodeText(buffer)));
      return [{ name: file.name, rows, raw: rows }];
    }
    if (!window.XLSX) {
      const e = new Error("The spreadsheet reader didn't load. Save the file as CSV and try again.");
      e.userMessage = e.message;
      throw e;
    }
    const wb = window.XLSX.read(new Uint8Array(buffer), { type: 'array' });
    return wb.SheetNames.map((name) => {
      const ws = wb.Sheets[name];
      const text = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true });
      const raw = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true });
      return Object.assign({ name }, tidySheet(text, raw));
    });
  }

  async function loadFile(file) {
    showError('upload', '');
    try {
      const sheets = await readSheets(file);
      if (looksLikeCensusResults(sheets[0].rows)) {
        showError('upload', 'That looks like a Census results file. Add your original spreadsheet first, then bring the results file back in Step 2.');
        return;
      }
      useData(file.name, sheets);
    } catch (e) {
      if (!e.userMessage) console.error(e);
      showError('upload', e.userMessage || "That file couldn't be read. Is it a spreadsheet (.xlsx, .xls, .ods or .csv)?");
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

  function useData(fileName, sheets, opts) {
    const usable = sheets.filter((s) => s.rows.length);
    if (!usable.length) {
      showError('upload', 'That file looks empty.');
      return;
    }
    state.fileName = fileName;
    state.sheets = usable;
    state.census = new Map();
    state.censusNote = null;
    state.example = false;
    let biggest = 0;
    usable.forEach((s, i) => {
      if (s.rows.length > usable[biggest].rows.length) biggest = i;
    });
    selectSheet(biggest);
    if (!(opts && opts.quiet)) {
      showSteps(['configure']);
      window.scrollTo(0, 0);
    }
  }

  function selectSheet(index) {
    state.sheetIndex = index;
    state.hasHeader = A.detectHeaderRow(currentSheet().rows);
    state.census = new Map();
    state.censusNote = null;
    detectMapping();
    renderConfigure();
  }

  const currentSheet = () => state.sheets[state.sheetIndex];

  function headers() {
    const sheet = currentSheet();
    const width = sheet.rows[0] ? sheet.rows[0].length : 0;
    const out = [];
    for (let i = 0; i < width; i++) out.push((state.hasHeader && sheet.rows[0][i]) || 'Column ' + columnLetter(i));
    return out;
  }

  /** Data rows; `id` is the row's position in the sheet, so it survives header changes. */
  function dataRows() {
    const sheet = currentSheet();
    const skip = state.hasHeader ? 1 : 0;
    return sheet.rows.slice(skip).map((text, i) => ({ id: i + skip, text, raw: sheet.raw[i + skip] || text }));
  }

  function detectMapping() {
    state.mapping = A.detectColumns(headers(), dataRows().map((r) => r.text));
  }

  // ---------------------------------------------------------------------------
  // Coordinates: from the file, or from Census batch results
  // ---------------------------------------------------------------------------

  function fileCoords(row) {
    const m = state.mapping;
    if (m.lat === null || m.lon === null) return null;
    const lat = A.parseCoordinate(row.raw[m.lat], 'lat');
    const lon = A.parseCoordinate(row.raw[m.lon], 'lon');
    if (lat === null || lon === null || (lat === 0 && lon === 0)) return null;
    return { lat, lon, source: 'given' };
  }

  function coordsFor(row) {
    return fileCoords(row) || state.census.get(row.id) || null;
  }

  function buildOne(row, defaultLocality) {
    return A.buildAddress(row.text, state.mapping, { areaHint: $('#area-hint').value.trim(), defaultLocality });
  }

  function defaultLocalityFor(rows) {
    if ($('#area-hint').value.trim()) return '';
    return A.inferDefaultLocality(rows.map((r) => A.buildAddress(r.text, state.mapping, {})));
  }

  /** Splits "123 Main St, Springfield, IL 62701" into the Census batch columns. */
  function censusFields(query) {
    const parts = query.split(',').map((p) => p.trim()).filter(Boolean);
    const street = parts.shift() || '';
    let city = '';
    let st = '';
    let zip = '';
    const last = parts.length ? parts[parts.length - 1] : '';
    const m = last.match(/^(?:([A-Za-z .]+?)\s+)?(\d{5})(?:-\d{4})?$/);
    if (m) {
      st = m[1] || '';
      zip = m[2];
      parts.pop();
    } else if (/^[A-Za-z]{2}$/.test(last) && parts.length > 1) {
      st = last;
      parts.pop();
    }
    if (parts.length) city = parts.filter((p) => !/^(usa|us|united states)$/i.test(p)).join(' ');
    return [street, city, st, zip];
  }

  function censusInputCsv() {
    const rows = dataRows();
    const defaultLocality = defaultLocalityFor(rows);
    const lines = [];
    for (const row of rows) {
      if (fileCoords(row)) continue;
      const a = buildOne(row, defaultLocality);
      if (a.empty) continue;
      lines.push(csvLine([row.id].concat(censusFields(a.query))));
    }
    return lines;
  }

  function looksLikeCensusResults(rows) {
    if (!rows.length) return false;
    const hits = rows.slice(0, 20).filter((r) => r.some((c) => /^(Match|No_Match|Tie)$/.test(c))).length;
    return hits >= Math.min(rows.length, 20) * 0.6;
  }

  /** Reads the Census batch results file: ID, input, Match, type, matched address, "lon,lat", ... */
  function parseCensusResults(text) {
    const rows = A.parseDelimited(text, ',');
    const out = new Map();
    let total = 0;
    for (const r of rows) {
      const id = parseInt(r[0], 10);
      if (!isFinite(id)) continue;
      total++;
      if (!r.some((c) => c === 'Match')) continue;
      const pair = r.find((c) => /^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/.test(c));
      if (!pair) continue;
      let [a, b] = pair.split(',').map(Number);
      // The Census lists longitude first; swap if a file has it the other way round.
      let lon = a;
      let lat = b;
      if (Math.abs(lat) > 90 || (Math.abs(a) <= 90 && Math.abs(b) > 90)) {
        lat = a;
        lon = b;
      }
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      const matchedIdx = r.indexOf('Match');
      out.set(id, { lat, lon, source: 'census', matched: r[matchedIdx + 2] || '' });
    }
    return { matches: out, total };
  }

  async function loadCensusResults(file) {
    const status = $('#census-status');
    try {
      const text = decodeText(await file.arrayBuffer());
      const { matches, total } = parseCensusResults(text);
      if (!total) {
        state.censusNote = { ok: false, text: "That file doesn't look like Census results. Use the GeocodeResults.csv file the Census website gives you." };
      } else {
        const ids = new Set(dataRows().map((r) => r.id));
        let used = 0;
        for (const [id, c] of matches) {
          if (ids.has(id)) {
            state.census.set(id, c);
            used++;
          }
        }
        state.censusNote = used
          ? { ok: true, text: 'Found ' + used + ' of ' + total + ' addresses.' + (used < total ? ' The rest are listed after sorting so you can check them.' : '') }
          : { ok: false, text: "None of those results match this spreadsheet. Make sure it's the results for the file you saved from this page." };
      }
    } catch (e) {
      console.error(e);
      state.censusNote = { ok: false, text: "That file couldn't be read." };
    }
    if (status) status.textContent = '';
    renderPreview();
    renderCoordsPanel();
    renderStartPicker();
  }

  // ---------------------------------------------------------------------------
  // Step 2: configure
  // ---------------------------------------------------------------------------

  function renderConfigure() {
    const sheet = currentSheet();
    const count = sheet.rows.length - (state.hasHeader ? 1 : 0);
    $('#file-summary').textContent = state.fileName + ' · ' + count + (count === 1 ? ' row' : ' rows');
    $('#sheet-row').hidden = state.sheets.length < 2;
    $('#sheet-select').replaceChildren(...state.sheets.map((s, i) => el('option', { value: i, selected: i === state.sheetIndex }, s.name)));
    $('#has-header').checked = state.hasHeader;
    renderMapping();
    renderPreview();
    renderCoordsPanel();
    renderStartPicker();
  }

  function renderMapping() {
    const hs = headers();
    $('#mapping').replaceChildren(
      ...ROLES.map((role) => {
        const id = 'map-' + role.key;
        const select = el(
          'select',
          { id, 'data-role': role.key },
          el('option', { value: '' }, '(none)'),
          hs.map((h, i) => el('option', { value: i, selected: state.mapping[role.key] === i }, h))
        );
        select.addEventListener('change', () => {
          state.mapping[role.key] = select.value === '' ? null : Number(select.value);
          renderPreview();
          renderCoordsPanel();
          renderStartPicker();
        });
        return el('div', { class: 'mapping-item' + (state.mapping[role.key] !== null ? ' is-set' : '') }, el('label', { for: id }, role.label), select);
      })
    );
  }

  function renderPreview() {
    for (const item of $$('#mapping .mapping-item')) {
      item.classList.toggle('is-set', state.mapping[$('select', item).dataset.role] !== null);
    }
    const hs = headers();
    const rows = dataRows();
    const sample = rows.slice(0, 6);
    const defaultLocality = defaultLocalityFor(rows);
    const used = new Set(Object.values(state.mapping).filter((v) => v !== null));
    const useText = (row) => {
      const c = coordsFor(row);
      const a = buildOne(row, defaultLocality);
      if (c) return c.lat.toFixed(5) + ', ' + c.lon.toFixed(5);
      return a.empty ? '' : a.query + ' (no coordinates yet)';
    };
    const table = $('#preview');
    table.replaceChildren(
      el('thead', null, el('tr', null, hs.map((h, i) => el('th', { class: used.has(i) ? 'is-used' : null }, h)), el('th', { class: 'use-col' }, 'Location'))),
      el(
        'tbody',
        null,
        sample.map((r) =>
          el(
            'tr',
            null,
            r.text.map((c, i) => el('td', { class: used.has(i) ? 'is-used' : null }, c)),
            el('td', { class: 'use-col' }, useText(r) || el('span', { class: 'muted' }, '(empty)'))
          )
        )
      )
    );
    if (rows.length > sample.length) {
      table.append(el('tfoot', null, el('tr', null, el('td', { colspan: hs.length + 1, class: 'muted' }, '…and ' + (rows.length - sample.length) + ' more'))));
    }
  }

  function renderCoordsPanel() {
    const panel = $('#coords-panel');
    const rows = dataRows();
    const defaultLocality = defaultLocalityFor(rows);
    let withCoords = 0;
    let withAddress = 0;
    for (const r of rows) {
      if (coordsFor(r)) withCoords++;
      else if (!buildOne(r, defaultLocality).empty) withAddress++;
    }
    const total = rows.length;
    panel.classList.toggle('ready', withCoords > 0 && withAddress === 0);
    $('#sort-go').disabled = withCoords === 0;

    if (withAddress === 0) {
      panel.replaceChildren(
        el('h3', null, withCoords === total ? 'Ready: every row has map coordinates' : withCoords + ' of ' + total + ' rows have map coordinates')
      );
      return;
    }

    const parts = [];
    parts.push(
      el('h3', null, withCoords ? withAddress + ' addresses still need map coordinates' : 'Your addresses need map coordinates first'),
      el(
        'p',
        { class: 'hint' },
        "This version runs inside Claude, which can't connect to address lookup services. For US addresses, the free US Census geocoder adds them in about a minute:"
      )
    );
    const saveBtn = el('button', { type: 'button', class: 'btn btn-small', id: 'census-save' }, 'Save address file for the Census');
    const copyBtn = el('button', { type: 'button', class: 'btn btn-small btn-quiet', id: 'census-copy' }, 'Copy it instead');
    const saveStatus = el('span', { class: 'save-status', id: 'census-save-status', role: 'status' });
    saveBtn.addEventListener('click', async () => {
      const lines = censusInputCsv();
      if (lines.length > CENSUS_BATCH_LIMIT) {
        saveStatus.textContent = 'The Census takes up to ' + CENSUS_BATCH_LIMIT + ' addresses per file; only the first ' + CENSUS_BATCH_LIMIT + ' were included.';
      }
      await saveFile('addresses-for-census.csv', lines.slice(0, CENSUS_BATCH_LIMIT).join('\r\n') + '\r\n', saveStatus);
    });
    copyBtn.addEventListener('click', () => copyText(censusInputCsv().slice(0, CENSUS_BATCH_LIMIT).join('\n'), saveStatus, 'Copied. Paste it into a text file and save it as addresses.csv.'));
    if (!state.downloads) saveBtn.hidden = true;

    const resultsInput = el('input', { type: 'file', id: 'census-results', accept: '.csv,.txt' });
    resultsInput.addEventListener('change', () => {
      if (resultsInput.files && resultsInput.files[0]) loadCensusResults(resultsInput.files[0]);
    });
    const drop = el(
      'label',
      { class: 'dropzone compact', for: 'census-results' },
      resultsInput,
      el('strong', null, 'Drop GeocodeResults.csv here'),
      el('span', null, 'or ', el('span', { class: 'link-like' }, 'choose the file'))
    );
    wireDrop(drop, loadCensusResults);

    parts.push(
      el(
        'ol',
        null,
        el(
          'li',
          null,
          el('p', null, 'Save your addresses in the Census format.'),
          el('div', { class: 'actions', style: 'margin-top:0' }, saveBtn, state.downloads ? null : copyBtn, saveStatus)
        ),
        el(
          'li',
          null,
          el(
            'p',
            null,
            'Open the ',
            el('a', { href: CENSUS_BATCH_URL, target: '_blank', rel: 'noopener' }, 'US Census batch geocoder'),
            ', choose that file, leave Benchmark as Public_AR_Current, and press Get Results. Your browser downloads GeocodeResults.csv.'
          )
        ),
        el(
          'li',
          null,
          el('p', null, 'Bring the results back here.'),
          drop,
          el('p', { id: 'census-status', class: 'status-line' + (state.censusNote ? (state.censusNote.ok ? ' ok' : ' bad') : '') }, state.censusNote ? state.censusNote.text : '')
        )
      ),
      el(
        'p',
        { class: 'fine' },
        'Outside the US? Add Latitude and Longitude columns to your spreadsheet, or use the ',
        el('a', { href: FULL_APP_URL, target: '_blank', rel: 'noopener' }, 'full Address Sorter'),
        ', which looks addresses up for you.'
      )
    );
    if (withCoords) parts.push(el('p', { class: 'fine' }, 'You can also sort now: the ' + withCoords + ' rows with coordinates are routed and the rest are listed separately.'));
    panel.replaceChildren(...parts);
  }

  function renderStartPicker() {
    const pick = $('#start-stop');
    const show = $('#start-mode').value === 'pick';
    pick.hidden = !show;
    if (!show) return;
    const rows = dataRows();
    const defaultLocality = defaultLocalityFor(rows);
    const previous = pick.value;
    pick.replaceChildren(
      ...rows
        .filter((r) => coordsFor(r))
        .map((r) => {
          const a = buildOne(r, defaultLocality);
          const label = a.empty ? coordsFor(r).lat.toFixed(5) + ', ' + coordsFor(r).lon.toFixed(5) : a.display;
          return el('option', { value: r.id, selected: String(r.id) === previous }, label);
        })
    );
  }

  function readOptions() {
    return {
      startMode: $('#start-mode').value,
      startStop: $('#start-stop').value === '' ? null : Number($('#start-stop').value),
      loop: $('#finish-mode').value === 'loop',
      avoidCrossing: $('#crossing-mode').value === 'avoid',
    };
  }

  // ---------------------------------------------------------------------------
  // Sorting
  // ---------------------------------------------------------------------------

  function buildStops() {
    const rows = dataRows();
    const defaultLocality = defaultLocalityFor(rows);
    state.stops = [];
    state.skippedRows = [];
    for (const row of rows) {
      const a = buildOne(row, defaultLocality);
      const c = coordsFor(row);
      if (a.empty && !c) {
        state.skippedRows.push(row);
        continue;
      }
      state.stops.push({
        id: row.id,
        row,
        display: a.empty ? c.lat.toFixed(5) + ', ' + c.lon.toFixed(5) : a.display,
        query: a.empty ? '' : a.query,
        streetKey: a.streetKey,
        number: a.number,
        isUS: a.isUS,
        lat: c ? c.lat : null,
        lon: c ? c.lon : null,
        precision: c ? c.source : null,
        status: c ? 'located' : 'nocoords',
        keep: false,
      });
    }
  }

  function fillGaps() {
    const byStreet = new Map();
    for (const s of state.stops) {
      if (s.status !== 'located' || !s.streetKey || s.number === null) continue;
      if (!byStreet.has(s.streetKey)) byStreet.set(s.streetKey, []);
      byStreet.get(s.streetKey).push({ number: s.number, lat: s.lat, lon: s.lon });
    }
    for (const s of state.stops) {
      if (s.status !== 'nocoords' || !s.streetKey || s.number === null) continue;
      const est = G.estimateFromNeighbours(s.number, byStreet.get(s.streetKey) || []);
      if (est) Object.assign(s, { lat: est.lat, lon: est.lon, precision: 'estimated', status: 'located' });
    }
  }

  function flagOutliers() {
    const located = state.stops.filter((s) => s.status === 'located');
    for (const i of G.findOutliers(located)) {
      if (located[i].precision !== 'given') located[i].status = 'outlier';
    }
  }

  const routable = (s) => s.lat !== null && (s.status === 'located' || (s.status === 'outlier' && s.keep));

  function plan() {
    const opts = state.options;
    let active = state.stops.filter(routable);
    let start = opts.startMode === 'first' ? 'first' : 'best';
    if (opts.startMode === 'pick' && opts.startStop !== null) {
      const chosen = active.find((s) => s.id === opts.startStop);
      if (chosen) {
        active = [chosen].concat(active.filter((s) => s !== chosen));
        start = 'first';
      }
    }
    const result = AS.planner.planRoute(
      active.map((s) => ({ lat: s.lat, lon: s.lon, street: s.streetKey, number: s.number, approx: s.precision === 'estimated' })),
      { start, loop: opts.loop, avoidCrossing: opts.avoidCrossing, timeLimitMs: Math.min(2500, 400 + 4 * active.length) }
    );
    state.route = {
      stops: result.order.map((i) => active[i]),
      legs: result.legs,
      returnLeg: result.returnLeg,
      total: result.total,
    };
    if (!state.units) state.units = active.filter((s) => s.isUS).length >= active.length / 2 ? 'imperial' : 'metric';
  }

  function runSort() {
    showError('configure', '');
    state.options = readOptions();
    buildStops();
    fillGaps();
    flagOutliers();
    if (!state.stops.some(routable)) {
      showError('configure', 'None of the rows have map coordinates yet. Follow the steps above to add them, or pick the Latitude and Longitude columns.');
      return;
    }
    const btn = $('#sort-go');
    btn.disabled = true;
    btn.textContent = 'Sorting…';
    setTimeout(() => {
      try {
        plan();
        state.example = false;
        showSteps(['results']);
        renderResults(true);
        window.scrollTo(0, 0);
      } catch (e) {
        console.error(e);
        showError('configure', 'Something went wrong while sorting: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sort into walking order';
      }
    }, 30);
  }

  // ---------------------------------------------------------------------------
  // Step 3: results
  // ---------------------------------------------------------------------------

  const fmt = (m) => G.formatDistance(m, state.units);

  function renderResults(fit) {
    $('#example-note').hidden = !state.example;
    $('#back-go').hidden = state.example;
    $('#restart-go').hidden = state.example;
    for (const b of $$('.units-toggle button')) b.classList.toggle('is-active', b.dataset.units === state.units);
    $('#save-status').textContent = '';
    renderSummary();
    renderAttention();
    renderNavLinks();
    renderTable();
    if (fit) fitMap();
    drawMap();
  }

  function notInRoute() {
    const inRoute = new Set(state.route.stops);
    return state.stops.filter((s) => !inRoute.has(s));
  }

  function renderSummary() {
    const r = state.route;
    const walk = r.total * STRAIGHT_LINE_DETOUR;
    const stat = (value, label) => el('div', { class: 'stat' }, el('span', { class: 'stat-value' }, value), el('span', { class: 'stat-label' }, label));
    const missing = notInRoute().length;
    $('#summary').replaceChildren(
      ...[
        el(
          'div',
          { class: 'stats' },
          stat(String(r.stops.length), r.stops.length === 1 ? 'stop' : 'stops'),
          r.stops.length > 1 && stat('≈ ' + fmt(walk), 'walking distance'),
          r.stops.length > 1 && stat('≈ ' + G.formatDuration(walk / WALK_SPEED_MPS), 'walking time at 3 mph')
        ),
        r.stops.length > 1 &&
          el('p', { class: 'hint' }, 'Straight lines between stops plus 20% for following streets. Time spent at each stop is not included.'),
        missing > 0 &&
          el('p', { class: 'status-line bad' }, missing + (missing === 1 ? " address isn't" : " addresses aren't") + ' in the route. See the list below.'),
      ].filter(Boolean)
    );
  }

  function renderAttention() {
    const box = $('#attention');
    const noCoords = state.stops.filter((s) => s.status === 'nocoords');
    const outliers = state.stops.filter((s) => s.status === 'outlier' && !s.keep);
    const estimated = state.route.stops.filter((s) => s.precision === 'estimated');
    const parts = [];
    const item = (s, note, action) =>
      el(
        'li',
        { class: 'attention-item' },
        el('div', { class: 'attention-text' }, el('strong', null, s.display), note ? el('span', { class: 'muted' }, note) : null),
        action || null
      );
    if (noCoords.length) {
      parts.push(
        el('h3', null, noCoords.length === 1 ? '1 address has no coordinates' : noCoords.length + ' addresses have no coordinates'),
        el('p', { class: 'hint' }, "They aren't in the route. The Census may not have recognised them: check the spelling and town, or add coordinates in your spreadsheet."),
        el('ul', { class: 'attention-list' }, noCoords.map((s) => item(s)))
      );
    }
    if (outliers.length) {
      parts.push(
        el('h3', null, outliers.length === 1 ? '1 address is far from the rest' : outliers.length + ' addresses are far from the rest'),
        el('p', { class: 'hint' }, "Left out because the match is probably in the wrong town. Keep it if the location is right."),
        el(
          'ul',
          { class: 'attention-list' },
          outliers.map((s) =>
            item(
              s,
              s.matched ? 'Matched to ' + s.matched : '',
              el(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-small',
                  onclick: () => {
                    s.keep = true;
                    plan();
                    renderResults(true);
                  },
                },
                'Keep it'
              )
            )
          )
        )
      );
    }
    if (estimated.length) {
      parts.push(
        el(
          'details',
          null,
          el('summary', null, estimated.length + (estimated.length === 1 ? ' stop has' : ' stops have') + ' an estimated position'),
          el('p', { class: 'hint' }, PRECISION.estimated.help),
          el('ul', { class: 'attention-list' }, estimated.map((s) => item(s)))
        )
      );
    }
    box.replaceChildren(...parts);
    box.hidden = !parts.length;
  }

  // ---- route sketch (SVG) ------------------------------------------------------

  function project(p, lat0) {
    return { x: p.lon * Math.cos((lat0 * Math.PI) / 180), y: -p.lat };
  }

  function fitMap() {
    const pts = state.route.stops;
    if (!pts.length) {
      state.view = null;
      return;
    }
    const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
    const xy = pts.map((p) => project(p, lat0));
    const minX = Math.min(...xy.map((p) => p.x));
    const maxX = Math.max(...xy.map((p) => p.x));
    const minY = Math.min(...xy.map((p) => p.y));
    const maxY = Math.max(...xy.map((p) => p.y));
    const box = $('#map-svg').getBoundingClientRect();
    const w = Math.max(200, box.width || 800);
    const h = Math.max(200, box.height || 460);
    const spanX = Math.max(maxX - minX, 1e-5);
    const spanY = Math.max(maxY - minY, 1e-5);
    const scale = Math.min((w - 80) / spanX, (h - 80) / spanY);
    state.view = { lat0, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, scale: Math.min(scale, 4e6) };
  }

  function niceScale(maxMeters) {
    const imperial = state.units !== 'metric';
    const unit = imperial ? 0.3048 : 1; // metres per foot / metre
    const big = imperial ? 1609.344 : 1000;
    const candidates = [];
    for (const v of [10, 20, 50, 100, 200, 500, 1000, 2000]) candidates.push({ m: v * unit, label: v + (imperial ? ' ft' : ' m') });
    for (const v of [0.25, 0.5, 1, 2, 5, 10, 20, 50, 100]) candidates.push({ m: v * big, label: v + (imperial ? ' mi' : ' km') });
    let best = candidates[0];
    for (const c of candidates) if (c.m <= maxMeters) best = c;
    return best;
  }

  function drawMap() {
    const svgEl = $('#map-svg');
    const box = svgEl.getBoundingClientRect();
    const w = Math.max(200, box.width || 800);
    const h = Math.max(200, box.height || 460);
    svgEl.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    const v = state.view;
    if (!v) {
      svgEl.replaceChildren(svg('text', { x: w / 2, y: h / 2, 'text-anchor': 'middle', fill: 'currentColor' }, 'No stops to show'));
      return;
    }
    const toPx = (p) => {
      const q = project(p, v.lat0);
      return [w / 2 + (q.x - v.cx) * v.scale, h / 2 + (q.y - v.cy) * v.scale];
    };
    const r = state.route;
    const kids = [];

    // Faint grid every ~80px for a sense of distance.
    for (let x = 40; x < w; x += 80) kids.push(svg('line', { class: 'grid-line', x1: x, y1: 0, x2: x, y2: h }));
    for (let y = 40; y < h; y += 80) kids.push(svg('line', { class: 'grid-line', x1: 0, y1: y, x2: w, y2: y }));

    const pts = r.stops.map(toPx);
    if (pts.length > 1) kids.push(svg('polyline', { class: 'route-line', points: pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ') }));
    if (state.options.loop && pts.length > 2) {
      const a = pts[pts.length - 1];
      const b = pts[0];
      kids.push(svg('line', { class: 'route-line route-return', x1: a[0], y1: a[1], x2: b[0], y2: b[1] }));
    }

    const dots = r.stops.length > 150;
    r.stops.forEach((stop, i) => {
      const [x, y] = pts[i];
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) return;
      const warn = (PRECISION[stop.precision] || {}).cls === 'warn';
      const radius = dots ? 5 : i + 1 >= 100 ? 13 : 11;
      const g = svg(
        'g',
        {
          class: 'pin' + (warn ? ' warn' : '') + (dots ? ' dot' : '') + (state.selected === stop.id ? ' is-selected' : ''),
          transform: 'translate(' + x.toFixed(1) + ',' + y.toFixed(1) + ')',
          'data-stop': stop.id,
        },
        svg('title', null, i + 1 + '. ' + stop.display),
        svg('circle', { r: radius }),
        dots ? null : svg('text', null, String(i + 1))
      );
      g.addEventListener('click', () => selectStop(stop, 'map'));
      kids.push(g);
    });

    // Scale bar, bottom right.
    const metersPerPx = 111195 / v.scale;
    const s = niceScale(metersPerPx * 120);
    const len = s.m / metersPerPx;
    kids.push(
      svg(
        'g',
        { class: 'scale-bar', transform: 'translate(' + (w - 16 - len) + ',' + (h - 16) + ')' },
        svg('line', { x1: 0, y1: 0, x2: len, y2: 0 }),
        svg('line', { x1: 0, y1: -5, x2: 0, y2: 0 }),
        svg('line', { x1: len, y1: -5, x2: len, y2: 0 }),
        svg('text', { x: len / 2, y: -8, 'text-anchor': 'middle' }, s.label)
      )
    );
    svgEl.replaceChildren(...kids);
  }

  function zoom(factor) {
    if (!state.view) return;
    state.view.scale *= factor;
    drawMap();
  }

  function wireMapControls() {
    const svgEl = $('#map-svg');
    let drag = null;
    svgEl.addEventListener('pointerdown', (e) => {
      if (!state.view || e.target.closest('.pin')) return;
      drag = { x: e.clientX, y: e.clientY, cx: state.view.cx, cy: state.view.cy };
      svgEl.setPointerCapture(e.pointerId);
      svgEl.classList.add('dragging');
    });
    svgEl.addEventListener('pointermove', (e) => {
      if (!drag) return;
      state.view.cx = drag.cx - (e.clientX - drag.x) / state.view.scale;
      state.view.cy = drag.cy - (e.clientY - drag.y) / state.view.scale;
      drawMap();
    });
    const end = () => {
      drag = null;
      svgEl.classList.remove('dragging');
    };
    svgEl.addEventListener('pointerup', end);
    svgEl.addEventListener('pointercancel', end);
    svgEl.addEventListener('dblclick', () => zoom(1.6));
    $('#zoom-in').addEventListener('click', () => zoom(1.6));
    $('#zoom-out').addEventListener('click', () => zoom(1 / 1.6));
    $('#zoom-fit').addEventListener('click', () => {
      fitMap();
      drawMap();
    });
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!$('#step-results').hidden && state.route) drawMap();
      }, 100);
    });
  }

  function selectStop(stop, from) {
    state.selected = stop.id;
    for (const tr of $$('#results-table tr.is-selected')) tr.classList.remove('is-selected');
    const row = $('#results-table tr[data-stop="' + stop.id + '"]');
    if (row) row.classList.add('is-selected');
    if (from === 'table' && state.view) {
      const q = project(stop, state.view.lat0);
      state.view.cx = q.x;
      state.view.cy = q.y;
      $('#map-svg').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    drawMap();
  }

  // ---- links and table ------------------------------------------------------

  const mapsPlace = (s) => s.query || s.lat.toFixed(6) + ',' + s.lon.toFixed(6);
  const mapsSearchUrl = (s) => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(mapsPlace(s));

  function renderNavLinks() {
    const pts = state.route.stops.map((s, i) => ({ place: mapsPlace(s), n: i + 1 }));
    if (state.options.loop && pts.length > 1) pts.push({ place: pts[0].place, n: 'start' });
    const links = [];
    for (let i = 0; i < pts.length - 1; i += NAV_CHUNK - 1) {
      const chunk = pts.slice(i, i + NAV_CHUNK);
      if (chunk.length < 2) break;
      const origin = chunk[0];
      const dest = chunk[chunk.length - 1];
      const waypoints = chunk.slice(1, -1).map((p) => p.place).join('|');
      const url =
        'https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=' + encodeURIComponent(origin.place) +
        '&destination=' + encodeURIComponent(dest.place) + (waypoints ? '&waypoints=' + encodeURIComponent(waypoints) : '');
      const label = 'Stop ' + origin.n + ' → ' + (dest.n === 'start' ? 'back to start' : 'stop ' + dest.n);
      links.push(el('a', { class: 'btn btn-small', href: url, target: '_blank', rel: 'noopener' }, label));
    }
    $('#nav-links').replaceChildren(...links);
    $('#nav-panel').hidden = !links.length;
  }

  function extraColumns() {
    const used = new Set(Object.values(state.mapping).filter((v) => v !== null));
    const rows = dataRows();
    return headers()
      .map((h, i) => ({ h, i }))
      .filter((c) => !used.has(c.i) && rows.some((r) => r.text[c.i]))
      .slice(0, 3);
  }

  function extraInline(extras, row) {
    const values = extras.map((c) => row.text[c.i]).filter(Boolean);
    return values.length ? el('div', { class: 'extra-inline muted' }, values.join(' · ')) : null;
  }

  function badge(stop) {
    if (stop.status === 'nocoords') return el('span', { class: 'badge badge-bad' }, 'No coordinates');
    if (stop.status === 'outlier' && !stop.keep) return el('span', { class: 'badge badge-bad' }, 'Far away?');
    const p = PRECISION[stop.precision];
    if (!p || p.cls === 'ok') return null;
    return el('span', { class: 'badge badge-warn', title: p.help || '' }, p.label);
  }

  function renderTable() {
    const extras = extraColumns();
    const r = state.route;
    const colCount = 4 + extras.length;
    const body = el('tbody');
    r.stops.forEach((stop, i) => {
      const tr = el(
        'tr',
        { tabindex: 0, 'data-stop': stop.id, class: state.selected === stop.id ? 'is-selected' : null },
        el('td', { class: 'num' }, String(i + 1)),
        extras.map((c) => el('td', { class: 'extra' }, stop.row.text[c.i] || '')),
        el('td', null, stop.display, ' ', badge(stop), extraInline(extras, stop.row)),
        el('td', { class: 'dist' }, i === 0 ? '' : fmt(r.legs[i])),
        el('td', { class: 'link-col' }, el('a', { href: mapsSearchUrl(stop), target: '_blank', rel: 'noopener' }, 'Map'))
      );
      tr.addEventListener('click', (e) => {
        if (!e.target.closest('a')) selectStop(stop, 'table');
      });
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') selectStop(stop, 'table');
      });
      body.append(tr);
    });
    if (state.options.loop && r.stops.length > 1) {
      body.append(
        el(
          'tr',
          { class: 'start-row' },
          el('td', { class: 'num' }, '↩'),
          extras.map(() => el('td', { class: 'extra' })),
          el('td', null, 'Back to the start'),
          el('td', { class: 'dist' }, fmt(r.returnLeg)),
          el('td', { class: 'link-col' })
        )
      );
    }
    const head = el(
      'tr',
      null,
      el('th', { class: 'num' }, '#'),
      extras.map((c) => el('th', { class: 'extra' }, c.h)),
      el('th', null, 'Address'),
      el('th', { class: 'dist' }, 'From previous'),
      el('th', { class: 'link-col' }, '')
    );
    const table = $('#results-table');
    table.replaceChildren(el('thead', null, head), body);
    const missing = notInRoute();
    if (missing.length) {
      table.append(
        el(
          'tbody',
          { class: 'missing' },
          el('tr', null, el('th', { colspan: colCount + 1, class: 'section-head' }, 'Not in the route')),
          missing.map((stop) =>
            el(
              'tr',
              null,
              el('td', { class: 'num' }, '–'),
              extras.map((c) => el('td', { class: 'extra' }, stop.row.text[c.i] || '')),
              el('td', null, stop.display, ' ', badge(stop), extraInline(extras, stop.row)),
              el('td', { class: 'dist' }),
              el('td', { class: 'link-col' })
            )
          )
        )
      );
    }
  }

  // ---- export -------------------------------------------------------------

  function noteFor(stop, inRoute) {
    if (!inRoute) return stop.status === 'nocoords' ? 'No coordinates' : 'Left out: far from the other addresses';
    return (PRECISION[stop.precision] || {}).label || '';
  }

  function exportRows(typed) {
    const m = state.mapping;
    const hasCoordColumns = m.lat !== null && m.lon !== null;
    const coord = (v) => (v === null || v === undefined ? '' : typed ? Number(v.toFixed(6)) : v.toFixed(6));
    const value = (text, raw, col) => {
      if (!typed || col === m.zip) return text;
      if (typeof raw === 'number' && String(raw) === text) return raw;
      if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(text)) return Number(text);
      return text;
    };
    const cellsFor = (row) => row.text.map((text, i) => value(text, row.raw[i], i));
    const coordCells = (stop) => (hasCoordColumns ? [] : [coord(stop && stop.lat), coord(stop && stop.lon)]);
    const out = [['Stop'].concat(headers(), hasCoordColumns ? [] : ['Latitude', 'Longitude'], ['Location', 'Walk from previous', 'Walk so far'])];
    const r = state.route;
    let soFar = 0;
    r.stops.forEach((stop, i) => {
      soFar += r.legs[i];
      out.push(
        [typed ? i + 1 : String(i + 1)].concat(cellsFor(stop.row), coordCells(stop), [
          noteFor(stop, true),
          i === 0 ? '' : fmt(r.legs[i]),
          i === 0 ? '' : fmt(soFar),
        ])
      );
    });
    if (state.options.loop && r.stops.length > 1) {
      out.push(['Back to start'].concat(headers().map(() => ''), coordCells(null), ['', fmt(r.returnLeg), fmt(r.total)]));
    }
    for (const stop of notInRoute()) out.push([''].concat(cellsFor(stop.row), coordCells(stop), [noteFor(stop, false), '', '']));
    for (const row of state.skippedRows) out.push([''].concat(cellsFor(row), coordCells(null), ['No address', '', '']));
    return out;
  }

  function exportName(ext) {
    return (state.fileName.replace(/\.[^.]+$/, '') || 'addresses') + ' - walking order.' + ext;
  }

  async function saveFile(filename, data, statusEl) {
    const status = statusEl || $('#save-status');
    if (!state.downloads) {
      status.textContent = "Saving files isn't available here. Use Copy list instead.";
      return;
    }
    status.textContent = '';
    try {
      const res = await state.downloads.save({ filename, data });
      status.textContent = res && res.status === 'delivered' ? '' : 'Saved ' + filename + '.';
    } catch (e) {
      if (e && e.code === 'declined') return;
      if (e && e.code === 'rate_limited') status.textContent = 'A save is already waiting for your answer.';
      else status.textContent = "Couldn't save the file" + (e && e.message ? ': ' + e.message : '.');
    }
  }

  function downloadXlsx() {
    const rows = exportRows(true);
    const ws = window.XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = rows[0].map((_, c) => ({
      wch: Math.min(50, Math.max(6, ...rows.slice(0, 200).map((r) => String(r[c] === undefined ? '' : r[c]).length))),
    }));
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, 'Walking order');
    const buf = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    saveFile(exportName('xlsx'), buf);
  }

  function downloadCsv() {
    saveFile(exportName('csv'), '\uFEFF' + exportRows(false).map(csvLine).join('\r\n'));
  }

  async function copyText(text, statusEl, okMessage) {
    try {
      await navigator.clipboard.writeText(text);
      statusEl.textContent = okMessage;
    } catch (e) {
      // Some views refuse the clipboard: show the text so it can be copied by hand.
      const area = el('textarea', { rows: 6, readonly: true, 'aria-label': 'Text to copy' });
      area.value = text;
      statusEl.replaceChildren('Select this text and copy it:', area);
      area.select();
    }
  }

  function copyList() {
    const text = exportRows(false)
      .map((r) => r.map((c) => String(c).replace(/[\t\n\r]+/g, ' ')).join('\t'))
      .join('\n');
    copyText(text, $('#save-status'), 'Copied. Paste it into a spreadsheet.');
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  function wireDrop(zone, onFile) {
    ['dragenter', 'dragover'].forEach((t) =>
      zone.addEventListener(t, (e) => {
        e.preventDefault();
        zone.classList.add('is-over');
      })
    );
    ['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, () => zone.classList.remove('is-over')));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) onFile(file);
    });
  }

  function restart() {
    state.sheets = [];
    state.stops = [];
    state.route = null;
    state.census = new Map();
    $('#file-input').value = '';
    showError('upload', '');
    showSteps(['upload']);
    window.scrollTo(0, 0);
  }

  function showExample() {
    const sample = AS.sample;
    const { rows } = tidySheet(sample.rows);
    useData(sample.fileName, [{ name: 'Sample', rows, raw: rows }], { quiet: true });
    state.options = { startMode: 'best', startStop: null, loop: false, avoidCrossing: false };
    buildStops();
    fillGaps();
    flagOutliers();
    plan();
    state.example = true;
    showSteps(['upload', 'results']);
    renderResults(true);
  }

  function init() {
    const input = $('#file-input');
    input.addEventListener('change', () => {
      if (input.files && input.files[0]) loadFile(input.files[0]);
    });
    wireDrop($('#dropzone'), loadFile);
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    $('#paste-go').addEventListener('click', () => loadPasted($('#paste-input').value));
    $('#sheet-select').addEventListener('change', (e) => selectSheet(Number(e.target.value)));
    $('#has-header').addEventListener('change', (e) => {
      state.hasHeader = e.target.checked;
      detectMapping();
      renderConfigure();
    });
    $('#area-hint').addEventListener('input', () => {
      renderPreview();
      renderCoordsPanel();
    });
    for (const id of ['start-mode', 'finish-mode', 'crossing-mode']) {
      const sel = $('#' + id);
      const saved = getPref(id, '');
      if (saved && $$('option', sel).some((o) => o.value === saved)) sel.value = saved;
      sel.addEventListener('change', () => {
        setPref(id, sel.value);
        if (id === 'start-mode') renderStartPicker();
      });
    }
    $('#sort-go').addEventListener('click', runSort);
    $('#download-xlsx').addEventListener('click', downloadXlsx);
    $('#download-csv').addEventListener('click', downloadCsv);
    $('#copy-list').addEventListener('click', copyList);
    $('#back-go').addEventListener('click', () => {
      showSteps(['configure']);
      window.scrollTo(0, 0);
    });
    for (const b of $$('[data-action="restart"]')) b.addEventListener('click', restart);
    for (const b of $$('.units-toggle button')) {
      b.addEventListener('click', () => {
        state.units = b.dataset.units;
        setPref('units', state.units);
        renderResults(false);
      });
    }
    wireMapControls();
    showExample();

    // Saving files needs the viewer's downloads capability; hide it when absent.
    if (window.claude && typeof window.claude.use === 'function') {
      window.claude
        .use('downloads')
        .then((d) => {
          state.downloads = d;
          $('#download-xlsx').hidden = !d || !window.XLSX;
          $('#download-csv').hidden = !d;
          if (state.sheets.length && !$('#step-configure').hidden) renderCoordsPanel();
        })
        .catch(() => {});
    }
  }

  init();
})();
