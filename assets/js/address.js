/*
 * Address handling: reading pasted/CSV text, detecting which spreadsheet
 * columns hold which part of an address, and normalizing street names so
 * addresses on the same street can be recognised.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AddressSorter = root.AddressSorter || {};
    root.AddressSorter.address = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Delimited text (CSV / TSV / pasted from a spreadsheet)
  // ---------------------------------------------------------------------------

  function detectDelimiter(text) {
    const firstLines = text.split(/\r\n|\n|\r/).slice(0, 5);
    const candidates = ['\t', ',', ';', '|'];
    let best = null;
    let bestScore = 0;
    for (const delim of candidates) {
      let score = 0;
      for (const line of firstLines) {
        let inQuotes = false;
        for (const ch of line) {
          if (ch === '"') inQuotes = !inQuotes;
          else if (ch === delim && !inQuotes) score++;
        }
      }
      if (score > bestScore) {
        best = delim;
        bestScore = score;
      }
    }
    return best;
  }

  /** Parses CSV/TSV text into an array of rows (arrays of strings). */
  function parseDelimited(text, delimiter) {
    text = String(text || '').replace(/^\uFEFF/, '');
    const delim = delimiter === undefined ? detectDelimiter(text) : delimiter;
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
        } else {
          field += ch;
        }
        i++;
        continue;
      }
      if (ch === '"' && field === '') {
        inQuotes = true;
      } else if (delim && ch === delim) {
        row.push(field);
        field = '';
      } else if (ch === '\n' || ch === '\r') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        if (ch === '\r' && text[i + 1] === '\n') i++;
      } else {
        field += ch;
      }
      i++;
    }
    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }
    return cleanRows(rows);
  }

  /** Trims cells, drops fully blank rows and pads rows to the same width. */
  function cleanRows(rows) {
    const out = [];
    let width = 0;
    for (const r of rows) {
      const cells = (r || []).map((c) => (c === null || c === undefined ? '' : String(c).trim()));
      if (cells.some((c) => c !== '')) {
        out.push(cells);
        width = Math.max(width, cells.length);
      }
    }
    for (const r of out) while (r.length < width) r.push('');
    // Drop columns that are empty everywhere at the right-hand edge.
    while (width > 0 && out.every((r) => r[width - 1] === '')) {
      width--;
      for (const r of out) r.pop();
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Column detection
  // ---------------------------------------------------------------------------

  const ROLE_ORDER = ['lat', 'lon', 'zip', 'state', 'city', 'country', 'unit', 'number', 'address'];

  const HEADER_PATTERNS = {
    lat: /^(lat|latitude|lat\.|y|y coord(inate)?|gps lat(itude)?)$/,
    lon: /^(lon|lng|long|longitude|lon\.|x|x coord(inate)?|gps (lon|lng|long|longitude))$/,
    zip: /(^|\b)(zip|zipcode|zip code|zip\/postal( code)?|postal( code)?|post ?code|postcode|plz)(\b|$)/,
    state: /^(state|st|province|prov|region|state ?\/ ?province|county ?\/ ?state)$/,
    city: /(^|\b)(city|town|municipality|locality|suburb|village|city ?\/ ?town)(\b|$)/,
    country: /^(country|nation|country ?code|country ?name)$/,
    unit: /(^|\b)(unit|apt|apartment|suite|ste|address ?(line)? ?2|addr(ess)? ?2|street ?2|line ?2)(\b|$)/,
    number: /^(house ?(no|num|number|#)|street ?(no|num|number|#)|bldg ?(no|num|number)|building ?(no|number)|number|no|num|#|st ?num|house)$/,
    address: /(address|addr|location|street|property|site|destination|stop|road|residence)/,
  };

  const NOT_ADDRESS = /(e-?mail|ip ?addr|web|url|mac ?addr)/;

  function normalizeHeader(h) {
    return String(h || '')
      .toLowerCase()
      .replace(/[_\-.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function roleForHeader(header) {
    const h = normalizeHeader(header);
    if (!h) return null;
    for (const role of ROLE_ORDER) {
      if (role === 'address' && NOT_ADDRESS.test(h)) continue;
      if (HEADER_PATTERNS[role].test(h)) return role;
    }
    return null;
  }

  const STREET_LINE_RE = /^\s*\d+[A-Za-z]?(\s*-\s*\d+[A-Za-z]?)?(\s+1\/2)?[\s,]+[A-Za-z0-9]/;

  function looksLikeStreetAddress(value) {
    return STREET_LINE_RE.test(String(value || ''));
  }

  function isNumeric(value) {
    if (typeof value === 'number') return isFinite(value);
    const s = String(value || '').trim();
    return s !== '' && /^[-+]?\d+(\.\d+)?$/.test(s);
  }

  /**
   * Decides whether the first row is a header row. A header row has at least
   * one recognisable column name and no cell that looks like address data.
   */
  function detectHeaderRow(rows) {
    if (!rows.length) return false;
    const first = rows[0];
    const anyKnown = first.some((c) => roleForHeader(c));
    const anyData = first.some((c) => looksLikeStreetAddress(c) || isNumeric(c));
    if (anyKnown && !anyData) return true;
    if (anyData) return false;
    // Unknown words only: treat as header when the next rows look different.
    if (rows.length > 1) {
      const second = rows[1];
      return second.some((c) => looksLikeStreetAddress(c) || isNumeric(c));
    }
    return false;
  }

  function emptyMapping() {
    return { address: null, number: null, unit: null, city: null, state: null, zip: null, country: null, lat: null, lon: null };
  }

  function columnStats(dataRows, col, test) {
    let filled = 0;
    let hits = 0;
    for (const r of dataRows) {
      const v = r[col];
      if (v === '' || v === null || v === undefined) continue;
      filled++;
      if (test(v)) hits++;
    }
    return { filled, ratio: filled ? hits / filled : 0 };
  }

  function validCoordinate(kind) {
    const limit = kind === 'lat' ? 90 : 180;
    return (v) => isNumeric(v) && Math.abs(Number(v)) <= limit;
  }

  /**
   * Works out which column holds which piece of the address.
   * @param {string[]} headers column names (may be generic like "Column 1")
   * @param {Array<Array<string>>} dataRows rows without the header row
   */
  function detectColumns(headers, dataRows) {
    const mapping = emptyMapping();
    headers.forEach((h, idx) => {
      const role = roleForHeader(h);
      if (role && mapping[role] === null) mapping[role] = idx;
    });

    // Coordinates must actually contain coordinates.
    for (const kind of ['lat', 'lon']) {
      if (mapping[kind] !== null) {
        const stats = columnStats(dataRows, mapping[kind], validCoordinate(kind));
        if (stats.filled === 0 || stats.ratio < 0.8) mapping[kind] = null;
      }
    }
    if ((mapping.lat === null) !== (mapping.lon === null)) {
      mapping.lat = null;
      mapping.lon = null;
    }

    // A "number" column that is really a full street line ("123 Main St").
    if (mapping.number !== null) {
      const stats = columnStats(dataRows, mapping.number, looksLikeStreetAddress);
      if (stats.ratio > 0.5 && mapping.address === null) {
        mapping.address = mapping.number;
        mapping.number = null;
      }
    }

    // No address column by name: pick the column whose values look most like
    // street addresses.
    if (mapping.address === null) {
      let best = null;
      let bestRatio = 0;
      headers.forEach((_, idx) => {
        if (Object.values(mapping).includes(idx)) return;
        const stats = columnStats(dataRows, idx, looksLikeStreetAddress);
        if (stats.ratio > bestRatio) {
          best = idx;
          bestRatio = stats.ratio;
        }
      });
      if (best !== null && bestRatio >= 0.3) mapping.address = best;
    }

    // Still nothing: a single text column is almost certainly the addresses.
    if (mapping.address === null && mapping.lat === null) {
      const textCols = headers
        .map((_, idx) => idx)
        .filter((idx) => columnStats(dataRows, idx, (v) => !isNumeric(v)).ratio > 0.8);
      if (textCols.length === 1) mapping.address = textCols[0];
    }
    return mapping;
  }

  // ---------------------------------------------------------------------------
  // Street normalisation
  // ---------------------------------------------------------------------------

  const WORD_ABBREVIATIONS = {
    STREET: 'ST', STR: 'ST', AVENUE: 'AVE', AV: 'AVE', AVEN: 'AVE', AVN: 'AVE', ROAD: 'RD',
    DRIVE: 'DR', DRV: 'DR', LANE: 'LN', COURT: 'CT', CRT: 'CT', BOULEVARD: 'BLVD', BOUL: 'BLVD',
    PLACE: 'PL', TERRACE: 'TER', TERR: 'TER', CIRCLE: 'CIR', CIRC: 'CIR', PARKWAY: 'PKWY',
    PKY: 'PKWY', HIGHWAY: 'HWY', TRAIL: 'TRL', SQUARE: 'SQ', ALLEY: 'ALY', CRESCENT: 'CRES',
    POINT: 'PT', COVE: 'CV', HEIGHTS: 'HTS', EXPRESSWAY: 'EXPY', FREEWAY: 'FWY', MOUNT: 'MT',
    MOUNTAIN: 'MTN', CENTER: 'CTR', CENTRE: 'CTR', GARDENS: 'GDNS', GROVE: 'GRV', HOLLOW: 'HOLW',
    JUNCTION: 'JCT', MEADOWS: 'MDWS', PLAZA: 'PLZ', RIDGE: 'RDG', TURNPIKE: 'TPKE', VIEW: 'VW',
    VILLAGE: 'VLG', ESTATES: 'ESTS', CROSSING: 'XING', LANDING: 'LNDG', MANOR: 'MNR', BRANCH: 'BR',
    NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', NORTHEAST: 'NE', NORTHWEST: 'NW',
    SOUTHEAST: 'SE', SOUTHWEST: 'SW', FIRST: '1ST', SECOND: '2ND', THIRD: '3RD', FOURTH: '4TH',
    FIFTH: '5TH', SIXTH: '6TH', SEVENTH: '7TH', EIGHTH: '8TH', NINTH: '9TH', TENTH: '10TH',
  };

  // Unit designators that are safe to strip anywhere in the street line.
  const UNIT_RE = /(?:^|[\s,])(?:(?:apt|apartment|unit|ste|suite|rm|room)\.?\s*#?\s*|#\s*)([A-Za-z0-9][A-Za-z0-9-]*)\b/i;

  function normalizeStreet(street) {
    return String(street || '')
      .toUpperCase()
      .replace(/[.,#'’]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => WORD_ABBREVIATIONS[w] || w)
      .join(' ');
  }

  /** Removes an apartment/suite designator, returning both parts. */
  function splitUnit(line) {
    const s = String(line || '');
    const m = s.match(UNIT_RE);
    if (!m) return { line: s.trim(), unit: '' };
    const unit = m[0].replace(/^[\s,]+/, '').trim();
    const rest = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length))
      .replace(/\s+,/g, ',')
      .replace(/,\s*,/g, ',')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s,]+|[\s,]+$/g, '');
    return { line: rest, unit };
  }

  /**
   * Splits "123B N Main Street" into house number and normalised street.
   * Works on the street line only (no city), but tolerates trailing text.
   */
  function parseStreetLine(line) {
    const { line: withoutUnit, unit } = splitUnit(line);
    const m = withoutUnit.match(/^\s*(\d+)([A-Za-z])?(?:\s*-\s*\d+[A-Za-z]?)?(?:\s+1\/2)?[\s,]+(.+)$/);
    if (!m) {
      return { number: null, numberSuffix: '', street: normalizeStreet(withoutUnit), unit };
    }
    return {
      number: parseInt(m[1], 10),
      numberSuffix: (m[2] || '').toUpperCase(),
      street: normalizeStreet(m[3]),
      unit,
    };
  }

  // ---------------------------------------------------------------------------
  // Building the text that gets sent to the geocoder
  // ---------------------------------------------------------------------------

  const US_STATES = new Set(
    ('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK ' +
      'OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR').split(' ')
  );
  const US_STATE_NAMES = new Set(
    ('alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho illinois ' +
      'indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri ' +
      'montana nebraska nevada ohio oklahoma oregon pennsylvania tennessee texas utah vermont virginia washington ' +
      'wisconsin wyoming').split(' ')
  );
  const US_COUNTRY = /^(us|usa|u\.s\.a?\.?|united states( of america)?|america)$/i;
  const ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;

  /** Guesses whether free-form address text is in the United States. */
  function looksUS(text) {
    const s = String(text || '');
    if (/\b(usa|u\.s\.a\.?|united states)\b/i.test(s)) return true;
    // Only look at the part after the street ("City, ST 12345").
    const tail = s.split(',').slice(1).join(' ');
    if (!tail) return /\b[A-Z]{2}\s+\d{5}(-\d{4})?\s*$/.test(s) && US_STATES.has(s.trim().split(/\s+/).slice(-2)[0]);
    const tokens = tail.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').split(/\s+/);
    if (tokens.some((t) => US_STATES.has(t))) return true;
    return tail.toLowerCase().split(/[^a-z]+/).some((t) => US_STATE_NAMES.has(t));
  }

  function cell(row, idx) {
    if (idx === null || idx === undefined) return '';
    const v = row[idx];
    return v === null || v === undefined ? '' : String(v).trim();
  }

  function containsText(haystack, needle) {
    return needle && haystack.toLowerCase().includes(needle.toLowerCase());
  }

  /** True when the address text already says which town/ZIP it is in. */
  function hasLocality(text) {
    return /,/.test(text) || ZIP_RE.test(text);
  }

  /**
   * Builds the address for one spreadsheet row.
   * @returns {{display:string, query:string, number:number|null, street:string, streetKey:string,
   *            unit:string, isUS:boolean, empty:boolean, locality:string}}
   */
  function buildAddress(row, mapping, opts) {
    opts = opts || {};
    let line = cell(row, mapping.address);
    const number = cell(row, mapping.number);
    if (number && !line.startsWith(number)) line = (number + ' ' + line).trim();
    const unitCol = cell(row, mapping.unit);
    const city = cell(row, mapping.city);
    const state = cell(row, mapping.state);
    const country = cell(row, mapping.country);
    let zip = cell(row, mapping.zip);
    // Excel drops the leading zero of ZIP codes such as 02134 (stored as 2134).
    if (/^\d{3,4}$/.test(zip) && (US_STATES.has(state.toUpperCase()) || US_COUNTRY.test(country))) {
      zip = zip.padStart(5, '0');
    }

    const streetPart = line.split(',')[0];
    const parsed = parseStreetLine(streetPart);
    const unit = unitCol || parsed.unit;

    const localityParts = [];
    if (city && !containsText(line, city)) localityParts.push(city);
    const stateZip = [state && !containsText(line, state) ? state : '', zip && !containsText(line, zip) ? zip : '']
      .filter(Boolean)
      .join(' ');
    if (stateZip) localityParts.push(stateZip);
    if (country && !containsText(line, country)) localityParts.push(country);

    const lineNoUnit = splitUnit(line).line;
    let query = [lineNoUnit].concat(localityParts).filter(Boolean).join(', ');
    let display = [line].concat(unitCol && !containsText(line, unitCol) ? [unitCol] : []).join(' ');
    display = [display].concat(localityParts).filter(Boolean).join(', ');

    const empty = !line && !localityParts.length;
    let locality = '';
    if (hasLocality(query)) {
      locality = query.split(',').slice(1).join(',').trim();
    } else if (!empty) {
      const hint = (opts.areaHint || '').trim() || (opts.defaultLocality || '').trim();
      if (hint) query = query + ', ' + hint;
    }

    const isUS = country
      ? US_COUNTRY.test(country)
      : US_STATES.has(state.toUpperCase()) || US_STATE_NAMES.has(state.toLowerCase()) || looksUS(query) ||
        (!state && /^\d{5}(-\d{4})?$/.test(zip));

    // Street plus town, so "Main St" in two different towns is not mixed up.
    const localityKey = query.split(',').slice(1).join(' ').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
    const streetKey = parsed.street ? parsed.street + '|' + localityKey : '';

    return {
      display: display || query,
      query,
      number: parsed.number,
      street: parsed.street,
      streetKey,
      unit,
      isUS,
      empty,
      locality,
    };
  }

  /**
   * Most common town/ZIP among rows that have one. Used for rows that only
   * say "123 Main St" so they are searched in the right place.
   */
  function inferDefaultLocality(addresses) {
    const counts = new Map();
    let withLocality = 0;
    for (const a of addresses) {
      if (!a.locality) continue;
      withLocality++;
      const key = a.locality;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    if (!withLocality) return '';
    let best = '';
    let bestCount = 0;
    for (const [k, c] of counts) {
      if (c > bestCount) {
        best = k;
        bestCount = c;
      }
    }
    return bestCount / withLocality >= 0.5 ? best : '';
  }

  function parseCoordinate(value, kind) {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!isFinite(n)) return null;
    if (kind === 'lat' && Math.abs(n) > 90) return null;
    if (kind === 'lon' && Math.abs(n) > 180) return null;
    return n;
  }

  return {
    parseDelimited,
    cleanRows,
    detectDelimiter,
    detectHeaderRow,
    detectColumns,
    roleForHeader,
    looksLikeStreetAddress,
    normalizeStreet,
    parseStreetLine,
    splitUnit,
    buildAddress,
    inferDefaultLocality,
    hasLocality,
    looksUS,
    parseCoordinate,
    emptyMapping,
  };
});
