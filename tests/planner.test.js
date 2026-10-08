'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planRoute } = require('../assets/js/planner.js');

// Houses along a narrow street running east, ~30 m apart; odd numbers on the
// north side, even numbers on the south side, ~10 m across.
function street(count) {
  const stops = [];
  for (let k = 0; k < count; k++) {
    stops.push({ lat: 40.00009, lon: -75 + k * 0.00035, street: 'OAK ST|X', number: 1 + 2 * k });
    stops.push({ lat: 40.0, lon: -75 + k * 0.00035, street: 'OAK ST|X', number: 2 + 2 * k });
  }
  return stops;
}

const sideChanges = (order, stops) =>
  order.slice(1).filter((idx, k) => stops[idx].number % 2 !== stops[order[k]].number % 2).length;

test('visits every stop once and reports leg distances', () => {
  const stops = street(6);
  const plan = planRoute(stops);
  assert.equal(plan.order.length, stops.length);
  assert.equal(new Set(plan.order).size, stops.length);
  assert.equal(plan.legs.length, stops.length);
  assert.equal(plan.legs[0], 0);
  assert.ok(Math.abs(plan.total - plan.legs.reduce((a, b) => a + b, 0)) < 1e-6);
});

test('zig-zags across a narrow street by default', () => {
  const stops = street(8);
  assert.ok(sideChanges(planRoute(stops).order, stops) > 4);
});

test('"one side at a time" finishes a side before crossing', () => {
  const stops = street(8);
  const plan = planRoute(stops, { avoidCrossing: true });
  assert.equal(sideChanges(plan.order, stops), 1);
});

test('starts at the first address when asked', () => {
  const stops = street(5);
  const plan = planRoute(stops, { start: 'first' });
  assert.equal(plan.order[0], 0);
});

test('starts from a custom point and can return to it', () => {
  const stops = street(5);
  const east = { lat: 40.00005, lon: -74.99 };
  const plan = planRoute(stops, { start: east, loop: true });
  assert.equal(plan.order.length, stops.length);
  // Nearest houses to a start point in the east are the eastern ones.
  assert.ok(stops[plan.order[0]].number >= 7);
  assert.ok(plan.legs[0] > 0);
  assert.ok(plan.returnLeg > 0);
});

test('orders street-level matches by house number', () => {
  // All six were only matched to the street, so they share one point.
  const stops = [7, 3, 11, 1, 9, 5].map((number) => ({ lat: 40, lon: -75, street: 'ELM ST|X', number, approx: true }));
  const plan = planRoute(stops);
  const numbers = plan.order.map((i) => stops[i].number);
  const asc = numbers.slice().sort((a, b) => a - b);
  assert.ok(JSON.stringify(numbers) === JSON.stringify(asc) || JSON.stringify(numbers) === JSON.stringify(asc.reverse()), numbers.join(','));
});

test('slots an approximate stop between its house-number neighbours', () => {
  const stops = [
    { lat: 40, lon: -75, street: 'OAK ST|X', number: 100 },
    { lat: 40, lon: -74.9985, street: 'OAK ST|X', number: 111 },
    { lat: 40, lon: -74.997, street: 'OAK ST|X', number: 120 },
    // Estimated position landed exactly on 111.
    { lat: 40, lon: -74.9985, street: 'OAK ST|X', number: 107, approx: true },
  ];
  const plan = planRoute(stops, { start: 'first' });
  assert.deepEqual(plan.order.map((i) => stops[i].number), [100, 107, 111, 120]);
});

test('uses a walking-distance matrix when given one', () => {
  // Three stops in a line, but the router says 0 -> 2 is a long detour.
  const stops = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.001 },
    { lat: 0, lon: 0.002 },
  ];
  const matrix = [0, 100, 9000, 100, 0, 100, 9000, 100, 0];
  const plan = planRoute(stops, { matrix });
  assert.deepEqual(plan.order[1], 1);
  assert.equal(plan.total, 200);
  // Missing entries fall back to the other direction or to a long detour.
  const sparse = planRoute(stops, { matrix: [0, 100, null, null, 0, 100, null, 100, 0], start: 'first' });
  assert.deepEqual(sparse.order, [0, 1, 2]);
});

test('handles empty and single-stop routes', () => {
  assert.deepEqual(planRoute([]).order, []);
  const one = planRoute([{ lat: 1, lon: 1 }], { loop: true });
  assert.deepEqual(one.order, [0]);
  assert.equal(one.total, 0);
});
