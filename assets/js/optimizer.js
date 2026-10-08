/*
 * Route optimiser: finds a short order to visit every stop (a "travelling
 * salesman" problem).
 *
 * Small problems are solved exactly. Larger ones use 2-opt and Or-opt local
 * search with nearest-neighbour candidate lists, improved further by iterated
 * local search (random "double bridge" kicks) until a time budget runs out.
 *
 * One-way routes are handled by adding a dummy node that costs nothing to
 * reach, turning the open path into a loop. A fixed starting stop is pinned
 * next to the dummy with a large negative cost.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AddressSorter = root.AddressSorter || {};
    root.AddressSorter.optimizer = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-7;
  const PIN = 1e9; // pins the start stop next to the dummy node
  const MATRIX_LIMIT = 2000;
  const EXACT_LIMIT = 8;

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  /** Cost of visiting `order` (an array of node indexes). */
  function routeCost(order, cost, loop) {
    let total = 0;
    for (let k = 1; k < order.length; k++) total += cost(order[k - 1], order[k]);
    if (loop && order.length > 1) total += cost(order[order.length - 1], order[0]);
    return total;
  }

  /** Exact answer by trying every order. Only for a handful of stops. */
  function solveExact(n, cost, start, loop) {
    const nodes = [];
    for (let i = 0; i < n; i++) if (i !== start) nodes.push(i);
    let bestOrder = null;
    let best = Infinity;
    const prefix = start === null ? [] : [start];
    const used = new Array(n).fill(false);
    const current = prefix.slice();

    function recurse(partial) {
      if (partial >= best) return;
      if (current.length === n) {
        const total = partial + (loop && n > 1 ? cost(current[n - 1], current[0]) : 0);
        if (total < best - EPS) {
          best = total;
          bestOrder = current.slice();
        }
        return;
      }
      for (const v of nodes) {
        if (used[v]) continue;
        // With a loop and no fixed start, fix the first node to skip rotations.
        if (loop && start === null && current.length === 0 && v !== nodes[0]) continue;
        const add = current.length ? cost(current[current.length - 1], v) : 0;
        used[v] = true;
        current.push(v);
        recurse(partial + add);
        current.pop();
        used[v] = false;
      }
    }
    recurse(0);
    return { order: bestOrder || [], cost: best === Infinity ? 0 : best };
  }

  /**
   * @param {number} n number of stops
   * @param {(i:number, j:number) => number} cost symmetric travel cost
   * @param {{start?: number|null, loop?: boolean, timeLimitMs?: number,
   *          seed?: number, maxIdle?: number}} [opts]
   * @returns {{order: number[], cost: number}}
   */
  function solve(n, cost, opts) {
    opts = opts || {};
    const start = opts.start === undefined || opts.start === null ? null : opts.start;
    const loop = !!opts.loop;
    if (start !== null && (start < 0 || start >= n)) throw new Error('start out of range');
    if (n === 0) return { order: [], cost: 0 };

    // Cache the matrix: the search looks up the same pairs many times.
    let base = cost;
    if (n <= MATRIX_LIMIT) {
      const m = new Float64Array(n * n);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const c = cost(i, j);
          m[i * n + j] = c;
          m[j * n + i] = c;
        }
      }
      base = (i, j) => m[i * n + j];
    }

    if (n <= EXACT_LIMIT) return solveExact(n, base, start, loop);

    const rand = mulberry32(opts.seed === undefined ? 12345 : opts.seed);
    const N = loop ? n : n + 1;
    const D = loop ? -1 : n; // dummy node index

    function C(i, j) {
      if (i === D || j === D) {
        if (i === j) return 0;
        const other = i === D ? j : i;
        return other === start ? -PIN : 0;
      }
      return base(i, j);
    }

    // ---- candidate (nearest neighbour) lists ------------------------------
    const K = Math.min(N - 1, opts.neighbours || 10);
    const neigh = new Int32Array(N * K);
    {
      const bestIdx = new Int32Array(K);
      const bestVal = new Float64Array(K);
      for (let i = 0; i < N; i++) {
        let count = 0;
        for (let j = 0; j < N; j++) {
          if (j === i) continue;
          const c = C(i, j);
          if (count < K) {
            let p = count++;
            while (p > 0 && bestVal[p - 1] > c) {
              bestVal[p] = bestVal[p - 1];
              bestIdx[p] = bestIdx[p - 1];
              p--;
            }
            bestVal[p] = c;
            bestIdx[p] = j;
          } else if (c < bestVal[K - 1]) {
            let p = K - 1;
            while (p > 0 && bestVal[p - 1] > c) {
              bestVal[p] = bestVal[p - 1];
              bestIdx[p] = bestIdx[p - 1];
              p--;
            }
            bestVal[p] = c;
            bestIdx[p] = j;
          }
        }
        for (let k = 0; k < K; k++) neigh[i * K + k] = bestIdx[k];
      }
    }

    // ---- tour representation ----------------------------------------------
    const tour = new Int32Array(N);
    const pos = new Int32Array(N);

    // Nearest-neighbour construction, beginning at the start (or dummy).
    {
      const visited = new Uint8Array(N);
      let current = D >= 0 ? D : start !== null ? start : 0;
      for (let k = 0; k < N; k++) {
        tour[k] = current;
        pos[current] = k;
        visited[current] = 1;
        if (k === N - 1) break;
        let next = -1;
        if (current === D && start !== null && !visited[start]) {
          next = start;
        } else {
          let bestC = Infinity;
          for (let k2 = 0; k2 < K; k2++) {
            const c = neigh[current * K + k2];
            if (!visited[c] && c !== D && C(current, c) < bestC) {
              bestC = C(current, c);
              next = c;
            }
          }
          if (next === -1) {
            for (let j = 0; j < N; j++) {
              if (!visited[j] && j !== D && C(current, j) < bestC) {
                bestC = C(current, j);
                next = j;
              }
            }
          }
        }
        current = next;
      }
    }

    const succ = (a) => tour[pos[a] + 1 === N ? 0 : pos[a] + 1];
    const pred = (a) => tour[pos[a] === 0 ? N - 1 : pos[a] - 1];

    function tourCost() {
      let total = 0;
      for (let k = 0; k < N; k++) total += C(tour[k], tour[k + 1 === N ? 0 : k + 1]);
      return total;
    }

    /** Reverses the tour between positions i..j (inclusive, going forward). */
    function reverse(i, j) {
      let len = ((j - i + N) % N) + 1;
      if (len * 2 > N) {
        // Reversing the other side gives the same loop and touches fewer nodes.
        const ni = (j + 1) % N;
        const nj = (i - 1 + N) % N;
        i = ni;
        j = nj;
        len = N - len;
      }
      for (let k = 0; k < len >> 1; k++) {
        const a = (i + k) % N;
        const b = (j - k + N) % N;
        const ta = tour[a];
        const tb = tour[b];
        tour[a] = tb;
        pos[tb] = a;
        tour[b] = ta;
        pos[ta] = b;
      }
    }

    // ---- local search ------------------------------------------------------
    // FIFO of nodes worth re-examining ("don't look bits"). Each node is in
    // the queue at most once, so a ring buffer of N slots is enough.
    const queue = new Int32Array(N);
    const queued = new Uint8Array(N);
    let qHead = 0;
    let qSize = 0;
    function push(v) {
      if (!queued[v]) {
        queued[v] = 1;
        queue[(qHead + qSize) % N] = v;
        qSize++;
      }
    }

    function try2opt(a) {
      for (let dir = 0; dir < 2; dir++) {
        const b = dir === 0 ? succ(a) : pred(a);
        const cab = C(a, b);
        for (let k = 0; k < K; k++) {
          const c = neigh[a * K + k];
          const g1 = cab - C(a, c);
          if (g1 <= EPS) break;
          if (c === b) continue;
          const d = dir === 0 ? succ(c) : pred(c);
          if (d === a) continue;
          const gain = g1 + C(c, d) - C(b, d);
          if (gain > EPS) {
            if (dir === 0) reverse(pos[b], pos[c]);
            else reverse(pos[a], pos[d]);
            push(a);
            push(b);
            push(c);
            push(d);
            return true;
          }
        }
      }
      return false;
    }

    function applyOrOpt(segPos, len, x, reversed) {
      const seg = [];
      for (let k = 0; k < len; k++) seg.push(tour[(segPos + k) % N]);
      if (reversed) seg.reverse();
      const rest = [];
      for (let k = 0, p = (segPos + len) % N; k < N - len; k++, p = (p + 1) % N) rest.push(tour[p]);
      const xi = rest.indexOf(x);
      const next = rest.slice(0, xi + 1).concat(seg, rest.slice(xi + 1));
      for (let k = 0; k < N; k++) {
        tour[k] = next[k];
        pos[next[k]] = k;
      }
    }

    function tryOrOpt(a) {
      const maxLen = Math.min(3, N - 3);
      for (let len = 1; len <= maxLen; len++) {
        const segPos = pos[a];
        const s1 = a;
        const sL = tour[(segPos + len - 1) % N];
        const p = pred(s1);
        const nx = succ(sL);
        const removeGain = C(p, s1) + C(sL, nx) - C(p, nx);
        if (removeGain <= EPS) continue;
        const inSeg = (v) => ((pos[v] - segPos + N) % N) < len;
        for (let end = 0; end < 2; end++) {
          const e = end === 0 ? s1 : sL;
          for (let k = 0; k < K; k++) {
            const c = neigh[e * K + k];
            if (C(e, c) >= removeGain) break;
            if (inSeg(c)) continue;
            // Two edges touch c: (c, succ c) and (pred c, c).
            for (let side = 0; side < 2; side++) {
              const x = side === 0 ? c : pred(c);
              const y = side === 0 ? succ(c) : c;
              if (inSeg(x) || inSeg(y)) continue;
              if (x === p && y === nx) continue;
              const cxy = C(x, y);
              const fwd = C(x, s1) + C(sL, y) - cxy;
              const rev = C(x, sL) + C(s1, y) - cxy;
              const reversed = rev < fwd;
              const add = reversed ? rev : fwd;
              if (removeGain - add > EPS) {
                applyOrOpt(segPos, len, x, reversed);
                push(p);
                push(nx);
                push(s1);
                push(sL);
                push(x);
                push(y);
                return true;
              }
            }
          }
        }
      }
      return false;
    }

    function localSearch() {
      while (qSize) {
        const a = queue[qHead];
        qHead = (qHead + 1) % N;
        qSize--;
        queued[a] = 0;
        while (try2opt(a) || tryOrOpt(a)) {
          /* keep improving around a */
        }
      }
    }

    for (let i = 0; i < N; i++) push(tour[i]);
    localSearch();

    // ---- iterated local search -------------------------------------------
    let best = Int32Array.from(tour);
    let bestCost = tourCost();
    const timeLimit = opts.timeLimitMs === undefined ? Math.min(3000, 300 + 5 * N) : opts.timeLimitMs;
    const maxIdle = opts.maxIdle === undefined ? Math.max(1500, 40 * N) : opts.maxIdle;
    const deadline = now() + timeLimit;
    let idle = 0;

    if (N >= 8) {
      const maxSeg = Math.max(1, Math.min(30, Math.floor((N - 2) / 3)));
      const scratch = new Int32Array(N);
      let iter = 0;
      while (idle < maxIdle) {
        if ((iter++ & 15) === 0 && now() > deadline) break;
        // Double bridge on a local window: A B C D -> A C B D.
        const s = Math.floor(rand() * N);
        const l1 = 1 + Math.floor(rand() * maxSeg);
        const l2 = 1 + Math.floor(rand() * maxSeg);
        const l3 = 1 + Math.floor(rand() * maxSeg);
        if (l1 + l2 + l3 >= N) continue;
        for (let k = 0; k < N; k++) scratch[k] = tour[(s + k) % N];
        // scratch: [0] A-end, [1..l1] B, [l1+1..l1+l2] C, rest D
        const bStart = 1;
        const cStart = 1 + l1;
        const dStart = 1 + l1 + l2;
        let w = 0;
        tour[w++] = scratch[0];
        for (let k = cStart; k < dStart; k++) tour[w++] = scratch[k];
        for (let k = bStart; k < cStart; k++) tour[w++] = scratch[k];
        for (let k = dStart; k < N; k++) tour[w++] = scratch[k];
        for (let k = 0; k < N; k++) pos[tour[k]] = k;
        push(scratch[0]);
        push(scratch[bStart]);
        push(scratch[cStart - 1]);
        push(scratch[cStart]);
        push(scratch[dStart - 1]);
        push(scratch[dStart]);
        if (dStart + l3 < N) push(scratch[dStart + l3]);
        push(scratch[N - 1]);
        localSearch();
        const c = tourCost();
        if (c < bestCost - EPS) {
          bestCost = c;
          best.set(tour);
          idle = 0;
        } else {
          tour.set(best);
          for (let k = 0; k < N; k++) pos[tour[k]] = k;
          idle++;
        }
      }
    }

    // ---- turn the loop into the answer ------------------------------------
    tour.set(best);
    for (let k = 0; k < N; k++) pos[tour[k]] = k;
    let order = [];
    if (loop) {
      const first = start !== null ? start : 0;
      for (let k = 0; k < N; k++) order.push(tour[(pos[first] + k) % N]);
    } else {
      const forward = start === null || succ(D) === start;
      for (let k = 1; k < N; k++) {
        order.push(tour[(pos[D] + (forward ? k : N - k)) % N]);
      }
    }
    return { order, cost: routeCost(order, base, loop) };
  }

  return { solve, routeCost, solveExact, mulberry32 };
});
