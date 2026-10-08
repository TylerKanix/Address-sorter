/*
 * Turns located addresses into a walking route: builds the walking cost
 * between every pair of stops, asks the optimiser for the best order and
 * works out the distance of each leg.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./geo.js'), require('./optimizer.js'));
  } else {
    root.AddressSorter = root.AddressSorter || {};
    root.AddressSorter.planner = factory(root.AddressSorter.geo, root.AddressSorter.optimizer);
  }
})(typeof self !== 'undefined' ? self : this, function (geo, optimizer) {
  'use strict';

  // Extra cost for crossing to the other side of the same street when the
  // walker prefers to finish one side first.
  const CROSSING_PENALTY_M = 60;
  // When a stop's position is only approximate, keep house numbers on the
  // same street in order by treating each number step as a short extra walk.
  const METERS_PER_HOUSE_NUMBER = 0.3;

  function sameStreet(a, b) {
    return !!a.street && a.street === b.street && a.number !== null && b.number !== null &&
      a.number !== undefined && b.number !== undefined;
  }

  /**
   * Builds the walking distance between nodes, using a street-network matrix
   * when one is supplied and straight lines otherwise.
   */
  function distanceFunction(nodes, matrix) {
    const n = nodes.length;
    if (!matrix) return (i, j) => (i === j ? 0 : geo.distance(nodes[i], nodes[j]));
    return (i, j) => {
      if (i === j) return 0;
      const a = matrix[i * n + j];
      const b = matrix[j * n + i];
      const okA = a !== null && a !== undefined && isFinite(a);
      const okB = b !== null && b !== undefined && isFinite(b);
      if (okA && okB) return (a + b) / 2;
      if (okA) return a;
      if (okB) return b;
      // No walking path found between these two: assume a long detour.
      return geo.distance(nodes[i], nodes[j]) * 3;
    };
  }

  /**
   * @param {Array<{lat:number, lon:number, street?:string, number?:number|null, approx?:boolean}>} stops
   * @param {{start?: 'best'|'first'|{lat:number, lon:number}, loop?: boolean,
   *          avoidCrossing?: boolean, matrix?: ArrayLike<number|null>,
   *          timeLimitMs?: number, seed?: number}} [options]
   *   `matrix` holds walking distances for the stops followed by the custom
   *   start point (if any), row-major.
   */
  function planRoute(stops, options) {
    options = options || {};
    const startOpt = options.start || 'best';
    const customStart = typeof startOpt === 'object' && startOpt !== null ? startOpt : null;
    const nodes = customStart ? stops.concat([{ lat: customStart.lat, lon: customStart.lon }]) : stops.slice();
    const n = nodes.length;
    const startNode = customStart ? n - 1 : startOpt === 'first' && stops.length ? 0 : null;
    const walk = distanceFunction(nodes, options.matrix || null);

    const cost = (i, j) => {
      let d = walk(i, j);
      if (i >= stops.length || j >= stops.length) return d;
      const a = stops[i];
      const b = stops[j];
      if (sameStreet(a, b)) {
        if (a.approx || b.approx) d += Math.abs(a.number - b.number) * METERS_PER_HOUSE_NUMBER;
        if (options.avoidCrossing && (a.number - b.number) % 2 !== 0) d += CROSSING_PENALTY_M;
      }
      return d;
    };

    const result = optimizer.solve(n, cost, {
      start: startNode,
      loop: !!options.loop,
      timeLimitMs: options.timeLimitMs,
      seed: options.seed,
    });

    let order = result.order;
    if (customStart) order = order.filter((i) => i !== n - 1);

    // Walking distance of each leg (no penalties), from the start point.
    const legs = [];
    let prev = customStart ? n - 1 : null;
    for (const idx of order) {
      legs.push(prev === null ? 0 : walk(prev, idx));
      prev = idx;
    }
    let returnLeg = 0;
    if (options.loop && order.length) {
      const home = customStart ? n - 1 : order[0];
      returnLeg = walk(order[order.length - 1], home);
    }
    const total = legs.reduce((s, d) => s + d, 0) + returnLeg;
    return { order, legs, returnLeg, total };
  }

  return { planRoute, CROSSING_PENALTY_M };
});
