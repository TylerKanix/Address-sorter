/*
 * Optional street-network distances from the public OpenStreetMap walking
 * router (OSRM, run by FOSSGIS). Used when the person ticks "Use real walking
 * paths", so rivers, rail lines and fenced blocks are taken into account.
 * Anything that goes wrong here falls back to straight-line distances.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AddressSorter = root.AddressSorter || {};
    root.AddressSorter.walking = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_BASE = 'https://routing.openstreetmap.de/routed-foot';
  const BLOCK = 50; // points per side of each table request (100 per request at most)
  const ROUTE_CHUNK = 50; // waypoints per route request
  const MAX_POINTS = 200;

  function coordString(points) {
    return points.map((p) => p.lon.toFixed(6) + ',' + p.lat.toFixed(6)).join(';');
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function getJson(fetchImpl, url, signal) {
    const res = await fetchImpl(url, signal ? { signal } : {});
    if (!res.ok) throw new Error('Walking router answered HTTP ' + res.status);
    const data = await res.json();
    if (!data || data.code !== 'Ok') throw new Error('Walking router error: ' + ((data && data.code) || 'unknown'));
    return data;
  }

  /**
   * Walking distance (metres) between every pair of points, as a flat
   * row-major array. Unreachable pairs are null.
   */
  async function fetchWalkingMatrix(points, opts) {
    opts = opts || {};
    const fetchImpl = opts.fetch || fetch.bind(globalThis);
    const base = opts.baseUrl || DEFAULT_BASE;
    const pause = opts.pauseMs === undefined ? 250 : opts.pauseMs;
    const n = points.length;
    if (n > MAX_POINTS) throw new Error('Too many stops for the walking router (max ' + MAX_POINTS + ').');
    const matrix = new Array(n * n).fill(null);
    const blocks = [];
    for (let i = 0; i < n; i += BLOCK) blocks.push(Array.from({ length: Math.min(BLOCK, n - i) }, (_, k) => i + k));
    const total = blocks.length * blocks.length;
    let done = 0;
    for (const from of blocks) {
      for (const to of blocks) {
        const same = from === to;
        const ids = same ? from : from.concat(to);
        const sources = from.map((_, k) => k).join(';');
        const destinations = (same ? from.map((_, k) => k) : to.map((_, k) => from.length + k)).join(';');
        const url =
          base + '/table/v1/driving/' + coordString(ids.map((i) => points[i])) +
          '?annotations=distance&sources=' + sources + '&destinations=' + destinations;
        const data = await getJson(fetchImpl, url, opts.signal);
        if (!Array.isArray(data.distances) || data.distances.length !== from.length) {
          throw new Error('Walking router returned an unexpected table.');
        }
        from.forEach((i, a) => {
          to.forEach((j, b) => {
            const v = data.distances[a][b];
            matrix[i * n + j] = typeof v === 'number' && isFinite(v) ? v : null;
          });
        });
        done++;
        if (opts.onProgress) opts.onProgress({ done, total });
        if (pause && done < total) await delay(pause);
      }
    }
    return matrix;
  }

  /**
   * Walking path through the points in order, for drawing on the map.
   * @returns {Promise<{path: Array<[number, number]>, distance: number}>} path as [lat, lon]
   */
  async function fetchWalkingPath(points, opts) {
    opts = opts || {};
    const fetchImpl = opts.fetch || fetch.bind(globalThis);
    const base = opts.baseUrl || DEFAULT_BASE;
    const path = [];
    let distance = 0;
    for (let i = 0; i < points.length - 1; i += ROUTE_CHUNK - 1) {
      const chunk = points.slice(i, i + ROUTE_CHUNK);
      if (chunk.length < 2) break;
      const url = base + '/route/v1/driving/' + coordString(chunk) + '?overview=full&geometries=geojson&steps=false';
      const data = await getJson(fetchImpl, url, opts.signal);
      const route = data.routes && data.routes[0];
      if (!route || !route.geometry) throw new Error('Walking router returned no route.');
      const coords = route.geometry.coordinates.map((c) => [c[1], c[0]]);
      if (path.length) coords.shift(); // first point repeats the previous chunk's last
      path.push(...coords);
      distance += route.distance || 0;
    }
    return { path, distance };
  }

  return { fetchWalkingMatrix, fetchWalkingPath, MAX_POINTS, DEFAULT_BASE };
});
