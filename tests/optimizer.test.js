'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { solve, solveExact, routeCost, mulberry32 } = require('../assets/js/optimizer.js');

function randomPoints(n, seed) {
  const rand = mulberry32(seed);
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([rand() * 1000, rand() * 1000]);
  return pts;
}
const euclid = (pts) => (i, j) => Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);

function assertPermutation(order, n) {
  assert.equal(order.length, n);
  assert.deepEqual(order.slice().sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i));
}

test('handles tiny inputs', () => {
  assert.deepEqual(solve(0, () => 0).order, []);
  assert.deepEqual(solve(1, () => 0).order, [0]);
  const two = solve(2, () => 5, { start: 1 });
  assert.deepEqual(two.order, [1, 0]);
  assert.equal(two.cost, 5);
});

for (const variant of [
  { name: 'open path, free start', start: null, loop: false },
  { name: 'open path, fixed start', start: 3, loop: false },
  { name: 'loop, fixed start', start: 2, loop: true },
  { name: 'loop, free start', start: null, loop: true },
]) {
  test(`matches the exact optimum on small random instances (${variant.name})`, () => {
    for (let seed = 1; seed <= 25; seed++) {
      const n = 9 + (seed % 2); // just above the exact-solver limit, so the heuristic runs
      const pts = randomPoints(n, seed);
      const cost = euclid(pts);
      const exact = solveExact(n, cost, variant.start, variant.loop);
      const got = solve(n, cost, { start: variant.start, loop: variant.loop, seed });
      assertPermutation(got.order, n);
      if (variant.start !== null) assert.equal(got.order[0], variant.start);
      assert.ok(Math.abs(got.cost - routeCost(got.order, cost, variant.loop)) < 1e-6);
      assert.ok(got.cost <= exact.cost + 1e-6, `seed ${seed}: ${got.cost} > optimum ${exact.cost}`);
    }
  });
}

test('finds the optimal snake through a grid', () => {
  const side = 12;
  const pts = [];
  for (let r = 0; r < side; r++) for (let c = 0; c < side; c++) pts.push([c * 10, r * 10]);
  // Shuffle so the input order carries no hint.
  const rand = mulberry32(7);
  for (let i = pts.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pts[i], pts[j]] = [pts[j], pts[i]];
  }
  const res = solve(pts.length, euclid(pts), { timeLimitMs: 3000 });
  assertPermutation(res.order, pts.length);
  // Optimal open path visits each point with a 10 m step.
  assert.ok(res.cost <= (side * side - 1) * 10 * 1.02, `cost ${res.cost}`);
});

test('is close to a known-good tour on 300 random points', () => {
  const pts = randomPoints(300, 99);
  const cost = euclid(pts);
  const res = solve(pts.length, cost, { timeLimitMs: 2000 });
  assertPermutation(res.order, 300);
  // Expected optimal tour length for n uniform points in a unit square is about
  // 0.7124 * sqrt(n * A). An open path is a little shorter.
  const expected = 0.7124 * Math.sqrt(300 * 1000 * 1000);
  assert.ok(res.cost < expected * 1.08, `cost ${res.cost} vs ~${expected}`);
});

test('is deterministic for a given seed', () => {
  const pts = randomPoints(60, 3);
  const a = solve(60, euclid(pts), { seed: 1 });
  const b = solve(60, euclid(pts), { seed: 1 });
  assert.deepEqual(a.order, b.order);
});

test('works without a cached matrix for very large inputs', () => {
  const pts = randomPoints(2100, 5);
  const res = solve(pts.length, euclid(pts), { timeLimitMs: 1500, start: 0 });
  assertPermutation(res.order, pts.length);
  assert.equal(res.order[0], 0);
});
