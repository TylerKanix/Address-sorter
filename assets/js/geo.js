/*
 * Small geographic helpers: distances, spotting addresses that were placed
 * far away from the rest, estimating a position from neighbouring house
 * numbers, and formatting distances/times for people.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AddressSorter = root.AddressSorter || {};
    root.AddressSorter.geo = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EARTH_RADIUS_M = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;

  /** Great-circle distance in metres. */
  function haversine(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function distance(a, b) {
    return haversine(a.lat, a.lon, b.lat, b.lon);
  }

  function median(values) {
    if (!values.length) return NaN;
    const s = values.slice().sort((x, y) => x - y);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /**
   * Returns the indexes of points that sit far away from the rest — usually a
   * geocoder matching "123 Main St" in the wrong town.
   */
  function findOutliers(points, opts) {
    opts = opts || {};
    const minPoints = opts.minPoints || 5;
    if (points.length < minPoints) return [];
    const center = { lat: median(points.map((p) => p.lat)), lon: median(points.map((p) => p.lon)) };
    const dists = points.map((p) => distance(p, center));
    const typical = median(dists);
    const factor = opts.factor || 10;
    const slack = opts.slackMeters === undefined ? 5000 : opts.slackMeters;
    const threshold = Math.max(typical * factor, typical + slack);
    const out = [];
    dists.forEach((d, i) => {
      if (d > threshold) out.push(i);
    });
    return out;
  }

  /**
   * Estimates where a house number sits on a street from other located
   * addresses on the same street, interpolating between the nearest numbers
   * below and above. Neighbours on the same side (same odd/even parity) are
   * preferred; otherwise both sides are used. Returns null when there is
   * nothing to go on.
   */
  function estimateFromNeighbours(number, neighbours) {
    if (number === null || number === undefined || !neighbours.length) return null;
    const bracket = (pool) => {
      let below = null;
      let above = null;
      for (const n of pool) {
        if (n.number <= number && (!below || n.number > below.number)) below = n;
        if (n.number >= number && (!above || n.number < above.number)) above = n;
      }
      return { below, above };
    };
    const sameSide = neighbours.filter((n) => n.number % 2 === number % 2);
    let b = bracket(sameSide);
    if (!b.below || !b.above) {
      const both = bracket(neighbours);
      if (both.below && both.above) b = both;
    }
    const { below, above } = b;
    if (below && above) {
      if (above.number === below.number) return { lat: below.lat, lon: below.lon };
      const t = (number - below.number) / (above.number - below.number);
      return { lat: below.lat + t * (above.lat - below.lat), lon: below.lon + t * (above.lon - below.lon) };
    }
    const nearest = below || above || bracket(neighbours).below || bracket(neighbours).above;
    return { lat: nearest.lat, lon: nearest.lon };
  }

  const METERS_PER_MILE = 1609.344;
  const METERS_PER_FOOT = 0.3048;

  function formatDistance(meters, units) {
    if (meters === null || meters === undefined || !isFinite(meters)) return '';
    if (units === 'metric') {
      if (meters < 1000) return Math.round(meters / 5) * 5 + ' m';
      return (meters / 1000).toFixed(meters < 10000 ? 2 : 1) + ' km';
    }
    const miles = meters / METERS_PER_MILE;
    if (miles < 0.1) return Math.round(meters / METERS_PER_FOOT / 10) * 10 + ' ft';
    return miles.toFixed(miles < 10 ? 2 : 1) + ' mi';
  }

  function formatDuration(seconds) {
    if (!isFinite(seconds)) return '';
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes < 60) return minutes + ' min';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h + ' h' + (m ? ' ' + m + ' min' : '');
  }

  return {
    haversine,
    distance,
    median,
    findOutliers,
    estimateFromNeighbours,
    formatDistance,
    formatDuration,
    METERS_PER_MILE,
  };
});
