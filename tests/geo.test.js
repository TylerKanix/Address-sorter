'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../assets/js/geo.js');

test('haversine distance', () => {
  // One degree of latitude is about 111.2 km.
  assert.ok(Math.abs(G.haversine(0, 0, 1, 0) - 111195) < 50);
  assert.equal(G.haversine(10, 10, 10, 10), 0);
});

test('flags a point geocoded in the wrong town', () => {
  const pts = [];
  for (let i = 0; i < 10; i++) pts.push({ lat: 40 + i * 0.001, lon: -75 + i * 0.001 });
  pts.push({ lat: 34.05, lon: -118.24 }); // Los Angeles
  assert.deepEqual(G.findOutliers(pts), [10]);
  assert.deepEqual(G.findOutliers(pts.slice(0, 10)), []);
  assert.deepEqual(G.findOutliers(pts.slice(0, 3)), []); // too few to judge
});

test('estimates a missing house between its neighbours', () => {
  const neighbours = [
    { number: 10, lat: 0, lon: 0 },
    { number: 30, lat: 0, lon: 0.002 },
    { number: 21, lat: 1, lon: 1 }, // other side of the street
  ];
  const est = G.estimateFromNeighbours(20, neighbours);
  assert.ok(Math.abs(est.lon - 0.001) < 1e-9);
  assert.equal(est.lat, 0);
  assert.deepEqual(G.estimateFromNeighbours(40, neighbours), { lat: 0, lon: 0.002 });
  assert.equal(G.estimateFromNeighbours(5, []), null);
  // No same-side neighbour below 15: use both sides (between 10 and 21).
  const across = G.estimateFromNeighbours(15, [{ number: 10, lat: 0, lon: 0 }, { number: 21, lat: 0, lon: 0.0011 }]);
  assert.ok(Math.abs(across.lon - 0.0005) < 1e-9);
});

test('formats distances and durations', () => {
  assert.equal(G.formatDistance(30, 'imperial'), '100 ft');
  assert.equal(G.formatDistance(1609.344 * 1.234, 'imperial'), '1.23 mi');
  assert.equal(G.formatDistance(452, 'metric'), '450 m');
  assert.equal(G.formatDistance(2500, 'metric'), '2.50 km');
  assert.equal(G.formatDuration(20), '1 min');
  assert.equal(G.formatDuration(3600 + 25 * 60), '1 h 25 min');
});
