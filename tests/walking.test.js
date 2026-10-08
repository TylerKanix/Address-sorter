'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchWalkingMatrix, fetchWalkingPath } = require('../assets/js/walking.js');

const points = (n) => Array.from({ length: n }, (_, i) => ({ lat: 40 + i * 0.001, lon: -75 }));

/** Fake OSRM table service: distance = 1000 * |index difference|. */
function fakeTable(all) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const coords = url.split('/table/v1/driving/')[1].split('?')[0].split(';');
    const params = new URL('http://x/?' + url.split('?')[1]).searchParams;
    const idx = coords.map((c) => all.findIndex((p) => p.lon.toFixed(6) + ',' + p.lat.toFixed(6) === c));
    const src = params.get('sources').split(';').map(Number);
    const dst = params.get('destinations').split(';').map(Number);
    const distances = src.map((s) => dst.map((d) => 1000 * Math.abs(idx[s] - idx[d])));
    return { ok: true, json: async () => ({ code: 'Ok', distances }) };
  };
  return { fetch, calls };
}

test('builds a full matrix from blocks of table requests', async () => {
  const pts = points(120);
  const { fetch, calls } = fakeTable(pts);
  const progress = [];
  const matrix = await fetchWalkingMatrix(pts, { fetch, pauseMs: 0, onProgress: (p) => progress.push(p.done) });
  assert.equal(calls.length, 9); // 3 x 3 blocks of up to 50
  assert.equal(progress.length, 9);
  for (const [i, j] of [[0, 119], [55, 3], [101, 102], [7, 7]]) assert.equal(matrix[i * 120 + j], 1000 * Math.abs(i - j));
  assert.ok(calls.every((u) => u.split('?')[0].split(';').length <= 100));
});

test('rejects router errors so the app can fall back', async () => {
  const fetch = async () => ({ ok: true, json: async () => ({ code: 'TooBig' }) });
  await assert.rejects(fetchWalkingMatrix(points(3), { fetch, pauseMs: 0 }), /TooBig/);
  const down = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(fetchWalkingMatrix(points(3), { fetch: down, pauseMs: 0 }), /503/);
  await assert.rejects(fetchWalkingMatrix(points(201), { fetch, pauseMs: 0 }), /Too many/);
});

test('stitches the walking path from chunks', async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const coords = url.split('/route/v1/driving/')[1].split('?')[0].split(';').map((c) => c.split(',').map(Number));
    return { ok: true, json: async () => ({ code: 'Ok', routes: [{ distance: 10 * (coords.length - 1), geometry: { coordinates: coords } }] }) };
  };
  const pts = points(120);
  const { path, distance } = await fetchWalkingPath(pts, { fetch });
  assert.equal(calls.length, 3);
  assert.equal(path.length, 120);
  assert.deepEqual(path[119], [pts[119].lat, pts[119].lon]);
  assert.equal(distance, 1190);
});
