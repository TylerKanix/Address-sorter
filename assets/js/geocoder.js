/*
 * Geocoding: turning address text into map coordinates.
 *
 * - US addresses go to the free US Census Bureau geocoder first. It knows the
 *   house-number ranges of every US street, so it places houses accurately.
 * - Everything else (and anything the Census geocoder misses) goes to
 *   OpenStreetMap's Nominatim service, which asks for at most one request
 *   per second.
 *
 * Results are cached in the browser so running the same list again is
 * instant and does not hit the services again.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AddressSorter = root.AddressSorter || {};
    root.AddressSorter.geocoder = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
  const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
  const CACHE_KEY = 'address-sorter:geocache:v1';
  const REQUEST_TIMEOUT_MS = 20000;

  function abortError() {
    const e = new Error('Cancelled');
    e.name = 'AbortError';
    return e;
  }

  function isAbort(e) {
    return e && e.name === 'AbortError';
  }

  function defaultSleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      const t = setTimeout(done, ms);
      function done() {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }
      function onAbort() {
        clearTimeout(t);
        reject(abortError());
      }
      if (signal) signal.addEventListener('abort', onAbort);
    });
  }

  let jsonpCounter = 0;
  /** Loads JSON through a <script> tag, for services that block cross-site fetch. */
  function browserJsonp(url, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (typeof document === 'undefined') return reject(new Error('JSONP needs a browser'));
      if (signal && signal.aborted) return reject(abortError());
      const name = '__addressSorterCb' + ++jsonpCounter;
      const script = document.createElement('script');
      let timer = null;
      function cleanup() {
        clearTimeout(timer);
        window[name] = function () {}; // a late reply must not throw
        script.remove();
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      function onAbort() {
        cleanup();
        reject(abortError());
      }
      window[name] = (data) => {
        cleanup();
        resolve(data);
      };
      script.onerror = () => {
        cleanup();
        reject(new Error('Request failed'));
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('Request timed out'));
      }, timeoutMs || REQUEST_TIMEOUT_MS);
      if (signal) signal.addEventListener('abort', onAbort);
      script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'callback=' + name;
      document.head.appendChild(script);
    });
  }

  /** Geocode cache kept in localStorage (or memory when that is unavailable). */
  function createCache(storage, maxEntries) {
    maxEntries = maxEntries || 5000;
    let data = {};
    try {
      if (storage) data = JSON.parse(storage.getItem(CACHE_KEY) || '{}') || {};
    } catch (e) {
      data = {};
    }
    const key = (provider, query) => provider + '|' + String(query).trim().toLowerCase();
    return {
      get(provider, query) {
        const hit = data[key(provider, query)];
        return hit ? { lat: hit.lat, lon: hit.lon, precision: hit.precision, source: hit.source, matched: hit.matched } : undefined;
      },
      set(provider, query, value) {
        data[key(provider, query)] = Object.assign({}, value, { t: Date.now() });
      },
      flush() {
        if (!storage) return;
        const keys = Object.keys(data);
        if (keys.length > maxEntries) {
          keys.sort((a, b) => (data[a].t || 0) - (data[b].t || 0));
          for (const k of keys.slice(0, keys.length - maxEntries)) delete data[k];
        }
        try {
          storage.setItem(CACHE_KEY, JSON.stringify(data));
        } catch (e) {
          /* storage full or blocked: the cache is only a convenience */
        }
      },
      clear() {
        data = {};
        try {
          if (storage) storage.removeItem(CACHE_KEY);
        } catch (e) {
          /* ignore */
        }
      },
      size() {
        return Object.keys(data).length;
      },
    };
  }

  function parseCensus(data) {
    const matches = data && data.result && data.result.addressMatches;
    if (!Array.isArray(matches) || !matches.length) return null;
    const m = matches[0];
    const lat = Number(m.coordinates && m.coordinates.y);
    const lon = Number(m.coordinates && m.coordinates.x);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return { lat, lon, precision: 'exact', source: 'census', matched: m.matchedAddress || '' };
  }

  function parseNominatim(data) {
    if (!Array.isArray(data) || !data.length) return null;
    const r = data[0];
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    const rank = Number(r.place_rank);
    const hasHouse = !!(r.address && r.address.house_number);
    let precision;
    if (hasHouse || rank >= 30) precision = 'exact';
    else if (rank >= 26 || (isNaN(rank) && (r.category === 'highway' || r.class === 'highway'))) precision = 'street';
    else return null; // only the town or postcode was found: no use for a walking order
    return { lat, lon, precision, source: 'osm', matched: r.display_name || '' };
  }

  /**
   * @param {{fetch?: Function, jsonp?: Function, sleep?: Function, now?: Function,
   *          storage?: Storage, cache?: object, email?: string,
   *          nominatimIntervalMs?: number, censusConcurrency?: number}} [options]
   */
  function createGeocoder(options) {
    options = options || {};
    const fetchImpl = options.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    const jsonpImpl = options.jsonp || browserJsonp;
    const sleep = options.sleep || defaultSleep;
    const now = options.now || (() => Date.now());
    const cache = options.cache || createCache(options.storage);
    const nominatimInterval = options.nominatimIntervalMs === undefined ? 1100 : options.nominatimIntervalMs;
    const censusConcurrency = options.censusConcurrency || 4;
    let censusMode = 'unknown'; // 'fetch' | 'jsonp' | 'jsonp-probe' | 'off'
    let lastNominatim = -Infinity;

    async function fetchJson(url, signal) {
      if (!fetchImpl) throw new TypeError('fetch is not available');
      if (signal && signal.aborted) throw abortError();
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const onAbort = () => ctrl && ctrl.abort();
      if (signal) signal.addEventListener('abort', onAbort);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (ctrl) ctrl.abort();
      }, REQUEST_TIMEOUT_MS);
      try {
        const res = await fetchImpl(url, ctrl ? { signal: ctrl.signal } : {});
        if (!res.ok) {
          const err = new Error('The service answered with an error (HTTP ' + res.status + ').');
          err.status = res.status;
          throw err;
        }
        return await res.json();
      } catch (e) {
        if (signal && signal.aborted) throw abortError();
        if (timedOut) {
          const t = new Error('The request timed out.');
          t.timeout = true;
          throw t;
        }
        throw e;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }

    async function census(query, signal) {
      const base = CENSUS_URL + '?address=' + encodeURIComponent(query) + '&benchmark=Public_AR_Current';
      if (censusMode === 'unknown' || censusMode === 'fetch') {
        try {
          const data = await fetchJson(base + '&format=json', signal);
          censusMode = 'fetch';
          return parseCensus(data);
        } catch (e) {
          if (isAbort(e)) throw e;
          // A real HTTP answer means the service works; just not this time.
          if (censusMode === 'fetch' || e.status) throw e;
          // The browser blocked the cross-site request: fall back to JSONP.
          censusMode = 'jsonp-probe';
        }
      }
      if (censusMode === 'jsonp-probe' || censusMode === 'jsonp') {
        try {
          const data = await jsonpImpl(base + '&format=jsonp', signal, REQUEST_TIMEOUT_MS);
          censusMode = 'jsonp';
          return parseCensus(data);
        } catch (e) {
          if (isAbort(e)) throw e;
          if (censusMode === 'jsonp-probe') censusMode = 'off';
          throw e;
        }
      }
      throw new Error('The US Census geocoder could not be reached.');
    }

    async function nominatim(query, signal) {
      const url =
        NOMINATIM_URL + '?format=jsonv2&addressdetails=1&limit=1&q=' + encodeURIComponent(query) +
        (options.email ? '&email=' + encodeURIComponent(options.email) : '');
      for (let attempt = 0; ; attempt++) {
        const wait = lastNominatim + nominatimInterval - now();
        if (wait > 0) await sleep(wait, signal);
        lastNominatim = now();
        try {
          return parseNominatim(await fetchJson(url, signal));
        } catch (e) {
          // Asked to slow down: back off once, then give up on this address.
          if (attempt === 0 && (e.status === 429 || e.status === 503)) {
            await sleep(5000, signal);
            continue;
          }
          throw e;
        }
      }
    }

    /**
     * Geocodes a list of unique addresses.
     * @param {Array<{query:string, isUS:boolean}>} items
     * @param {{provider?: 'auto'|'census'|'osm', signal?: AbortSignal,
     *          onProgress?: (p:{done:number,total:number}) => void}} [opts]
     * @returns {Promise<{results: Map<string, object|null>, errors: number, lastError: Error|null}>}
     */
    async function geocodeAll(items, opts) {
      opts = opts || {};
      const provider = opts.provider || 'auto';
      const signal = opts.signal;
      const results = new Map();
      let done = 0;
      let errors = 0;
      let lastError = null;
      const total = items.length;
      const progress = () => opts.onProgress && opts.onProgress({ done, total });
      const finish = (item, result) => {
        results.set(item.query, result);
        if (result) cache.set(provider, item.query, result);
        done++;
        progress();
      };
      const noteError = (e) => {
        errors++;
        lastError = e;
      };

      const pending = [];
      for (const item of items) {
        const hit = cache.get(provider, item.query);
        if (hit) {
          results.set(item.query, hit);
          done++;
        } else {
          pending.push(item);
        }
      }
      progress();

      const useCensus = (item) => provider === 'census' || (provider === 'auto' && item.isUS);
      const censusItems = pending.filter(useCensus);
      const osmItems = pending.filter((item) => !useCensus(item));

      async function censusOne(item) {
        if (signal && signal.aborted) throw abortError();
        let result = null;
        if (censusMode !== 'off') {
          try {
            result = await census(item.query, signal);
          } catch (e) {
            if (isAbort(e)) throw e;
            noteError(e);
          }
        }
        if (result || provider === 'census') finish(item, result);
        else osmItems.push(item);
      }

      try {
        let next = 0;
        // Run the first request alone so we learn how to reach the service.
        if (censusItems.length && censusMode === 'unknown') await censusOne(censusItems[next++]);
        const workers = [];
        for (let w = 0; w < censusConcurrency; w++) {
          workers.push(
            (async () => {
              while (next < censusItems.length) await censusOne(censusItems[next++]);
            })()
          );
        }
        await Promise.all(workers);

        for (const item of osmItems) {
          let result = null;
          try {
            result = await nominatim(item.query, signal);
          } catch (e) {
            if (isAbort(e)) throw e;
            noteError(e);
          }
          finish(item, result);
        }
      } finally {
        cache.flush();
      }
      return { results, errors, lastError };
    }

    return {
      geocodeAll,
      cache,
      get censusMode() {
        return censusMode;
      },
    };
  }

  return { createGeocoder, createCache, parseCensus, parseNominatim, CENSUS_URL, NOMINATIM_URL };
});
