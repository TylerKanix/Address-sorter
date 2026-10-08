'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGeocoder, createCache, parseNominatim } = require('../assets/js/geocoder.js');

const censusReply = (lat, lon) => ({
  result: { addressMatches: [{ matchedAddress: 'MATCHED', coordinates: { x: lon, y: lat } }] },
});
const noMatch = { result: { addressMatches: [] } };

function jsonResponse(body, status) {
  return { ok: !status || status < 400, status: status || 200, json: async () => body };
}

function memoryStorage() {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
    removeItem: (k) => delete data[k],
  };
}

function setup(handlers) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    for (const [pattern, handler] of handlers) if (url.includes(pattern)) return handler(url);
    throw new TypeError('Failed to fetch');
  };
  const sleeps = [];
  let clock = 0;
  const geocoder = createGeocoder({
    fetch,
    jsonp: handlers.jsonp || (async () => {
      throw new Error('no jsonp');
    }),
    storage: memoryStorage(),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  return { geocoder, calls, sleeps };
}

test('uses the Census geocoder for US addresses and OpenStreetMap for others', async () => {
  const { geocoder, calls } = setup([
    ['geocoding.geo.census.gov', () => jsonResponse(censusReply(38.9, -77.03))],
    ['nominatim', () => jsonResponse([{ lat: '51.5', lon: '-0.12', place_rank: 30, display_name: 'London' }])],
  ]);
  const { results, errors } = await geocoder.geocodeAll([
    { query: '1 Main St, Dover, DE', isUS: true },
    { query: '10 Downing St, London', isUS: false },
  ]);
  assert.equal(errors, 0);
  assert.deepEqual(results.get('1 Main St, Dover, DE'), { lat: 38.9, lon: -77.03, precision: 'exact', source: 'census', matched: 'MATCHED' });
  assert.equal(results.get('10 Downing St, London').source, 'osm');
  assert.ok(calls[0].includes('format=json'));
  assert.ok(calls[0].includes('benchmark=Public_AR_Current'));
  assert.equal(calls.length, 2);
});

test('falls back to OpenStreetMap when the Census geocoder has no match', async () => {
  const { geocoder } = setup([
    ['geocoding.geo.census.gov', () => jsonResponse(noMatch)],
    ['nominatim', () => jsonResponse([{ lat: '40', lon: '-75', place_rank: 27 }])],
  ]);
  const { results } = await geocoder.geocodeAll([{ query: '5 Elm St, X, PA', isUS: true }]);
  assert.deepEqual(results.get('5 Elm St, X, PA'), { lat: 40, lon: -75, precision: 'street', source: 'osm', matched: '' });
});

test('switches to JSONP when the browser blocks the Census request', async () => {
  const jsonpCalls = [];
  const handlers = [['nominatim', () => jsonResponse([])]];
  handlers.jsonp = async (url) => {
    jsonpCalls.push(url);
    return censusReply(1, 2);
  };
  const { geocoder, calls } = setup(handlers);
  const items = ['1 A St, X, NY', '2 A St, X, NY', '3 A St, X, NY'].map((query) => ({ query, isUS: true }));
  const { results } = await geocoder.geocodeAll(items);
  assert.equal(results.size, 3);
  for (const r of results.values()) assert.equal(r.source, 'census');
  // Only the first request tried fetch; the rest went straight to JSONP.
  assert.equal(calls.filter((u) => u.includes('census')).length, 1);
  assert.equal(jsonpCalls.length, 3);
  assert.ok(jsonpCalls[0].includes('format=jsonp'));
  assert.equal(geocoder.censusMode, 'jsonp');
});

test('gives up on the Census geocoder if it cannot be reached at all', async () => {
  const { geocoder, calls } = setup([['nominatim', () => jsonResponse([{ lat: '1', lon: '2', place_rank: 30 }])]]);
  const items = ['1 A St, X, NY', '2 A St, X, NY'].map((query) => ({ query, isUS: true }));
  const { results } = await geocoder.geocodeAll(items);
  assert.equal(geocoder.censusMode, 'off');
  for (const r of results.values()) assert.equal(r.source, 'osm');
  assert.equal(calls.filter((u) => u.includes('census')).length, 1);
});

test('waits between OpenStreetMap requests', async () => {
  const { geocoder, sleeps } = setup([['nominatim', () => jsonResponse([{ lat: '1', lon: '2', place_rank: 30 }])]]);
  const items = ['a', 'b', 'c'].map((query) => ({ query, isUS: false }));
  await geocoder.geocodeAll(items, { provider: 'osm' });
  assert.deepEqual(sleeps, [1100, 1100]);
});

test('backs off once when OpenStreetMap asks to slow down', async () => {
  let n = 0;
  const { geocoder, sleeps } = setup([
    ['nominatim', () => (n++ === 0 ? jsonResponse({}, 429) : jsonResponse([{ lat: '1', lon: '2', place_rank: 30 }]))],
  ]);
  const { results } = await geocoder.geocodeAll([{ query: 'a', isUS: false }], { provider: 'osm' });
  assert.ok(results.get('a'));
  assert.ok(sleeps.includes(5000));
});

test('counts errors and leaves the address unfound', async () => {
  const { geocoder } = setup([['nominatim', () => jsonResponse({}, 500)]]);
  const { results, errors, lastError } = await geocoder.geocodeAll([{ query: 'a', isUS: false }], { provider: 'osm' });
  assert.equal(results.get('a'), null);
  assert.equal(errors, 1);
  assert.match(lastError.message, /500/);
});

test('remembers results so repeat lookups are free', async () => {
  const storage = memoryStorage();
  let count = 0;
  const fetch = async () => {
    count++;
    return jsonResponse([{ lat: '1', lon: '2', place_rank: 30 }]);
  };
  const opts = { fetch, storage, sleep: async () => {}, nominatimIntervalMs: 0 };
  await createGeocoder(opts).geocodeAll([{ query: 'Some Place', isUS: false }], { provider: 'osm' });
  const again = await createGeocoder(opts).geocodeAll([{ query: 'some place ', isUS: false }], { provider: 'osm' });
  assert.equal(count, 1);
  assert.equal(again.results.get('some place ').lat, 1);
});

test('reports progress', async () => {
  const { geocoder } = setup([['nominatim', () => jsonResponse([{ lat: '1', lon: '2', place_rank: 30 }])]]);
  const seen = [];
  await geocoder.geocodeAll(
    ['a', 'b'].map((query) => ({ query, isUS: false })),
    { provider: 'osm', onProgress: (p) => seen.push(p.done + '/' + p.total) }
  );
  assert.deepEqual(seen, ['0/2', '1/2', '2/2']);
});

test('stops when cancelled', async () => {
  const ctrl = new AbortController();
  const { geocoder } = setup([
    [
      'nominatim',
      () => {
        ctrl.abort();
        return jsonResponse([{ lat: '1', lon: '2', place_rank: 30 }]);
      },
    ],
  ]);
  await assert.rejects(
    geocoder.geocodeAll(['a', 'b'].map((query) => ({ query, isUS: false })), { provider: 'osm', signal: ctrl.signal }),
    { name: 'AbortError' }
  );
});

test('ignores town-level OpenStreetMap matches', () => {
  assert.equal(parseNominatim([{ lat: '1', lon: '2', place_rank: 16 }]), null);
  assert.equal(parseNominatim([]), null);
  assert.equal(parseNominatim([{ lat: '1', lon: '2', place_rank: 18, address: { house_number: '5' } }]).precision, 'exact');
});

test('the cache keeps the newest entries when full', () => {
  const storage = memoryStorage();
  const cache = createCache(storage, 2);
  cache.set('osm', 'a', { lat: 1, lon: 1 });
  cache.set('osm', 'b', { lat: 2, lon: 2 });
  cache.set('osm', 'c', { lat: 3, lon: 3 });
  cache.flush();
  const reloaded = createCache(storage, 2);
  assert.equal(reloaded.size(), 2);
});
