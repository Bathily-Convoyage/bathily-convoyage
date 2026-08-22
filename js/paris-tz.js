/**
 * js/paris-tz.js — Europe/Paris temporal helper
 *
 * Converts local Paris date/time inputs (from <input type=date> and
 * <input type=time>) to UTC ISO timestamps, and converts UTC ISO
 * timestamps back to Paris display strings.
 *
 * NO hardcoded UTC+1 / UTC+2 offsets.
 * Uses Intl.DateTimeFormat with timeZone: 'Europe/Paris' and
 * timeZoneName: 'shortOffset' to discover offsets dynamically.
 *
 * FAIL CLOSED: if Intl cannot resolve the Paris offset, throws
 * TIMEZONE_RESOLUTION_UNAVAILABLE — never silently interprets
 * Paris as UTC.
 *
 * Runtime: V8 (Node.js, Cloudflare Pages Functions, browsers).
 * No npm dependency.
 *
 * Usage (browser): window.ParisTZ.parisToUtc(dateStr, timeStr)
 * Usage (Node):    var ParisTZ = require('./js/paris-tz.js');
 */

var ParisTZ = (function () {

  var PARIS_TZ = 'Europe/Paris';

  function pad2(n) {
    n = String(n);
    return n.length < 2 ? '0' + n : n;
  }

  /**
   * Parse the shortOffset string (e.g. "GMT+1", "GMT+02:00") into
   * signed minutes. Returns null if unparseable.
   */
  function parseShortOffset(offsetStr) {
    if (!offsetStr) return null;
    var m = String(offsetStr).match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return null;
    var sign = m[1] === '-' ? -1 : 1;
    var hours = parseInt(m[2], 10);
    var minutes = m[3] ? parseInt(m[3], 10) : 0;
    if (isNaN(hours) || isNaN(minutes)) return null;
    return sign * (hours * 60 + minutes);
  }

  /**
   * Get the Paris UTC offset (in signed minutes) for a given UTC instant.
   * FAIL CLOSED: throws TIMEZONE_RESOLUTION_UNAVAILABLE if Intl cannot
   * resolve the offset or if the format is unparseable.
   */
  function getParisOffsetMinutes(utcDate) {
    var parts;
    try {
      parts = new Intl.DateTimeFormat('en-US', {
        timeZone: PARIS_TZ,
        timeZoneName: 'shortOffset'
      }).formatToParts(utcDate);
    } catch (e) {
      throw new Error('TIMEZONE_RESOLUTION_UNAVAILABLE');
    }
    if (!parts || !parts.length) {
      throw new Error('TIMEZONE_RESOLUTION_UNAVAILABLE');
    }
    var offsetPart = null;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === 'timeZoneName') {
        offsetPart = parts[i].value;
        break;
      }
    }
    var offMin = parseShortOffset(offsetPart);
    if (offMin === null) {
      throw new Error('TIMEZONE_RESOLUTION_UNAVAILABLE');
    }
    return offMin;
  }

  /**
   * Get Paris local calendar parts (year, month, day, hour, minute)
   * for a given UTC instant.
   * FAIL CLOSED: throws on Intl failure.
   */
  function getParisParts(utcDate) {
    var parts;
    try {
      parts = new Intl.DateTimeFormat('en-US', {
        timeZone: PARIS_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).formatToParts(utcDate);
    } catch (e) {
      throw new Error('TIMEZONE_RESOLUTION_UNAVAILABLE');
    }
    if (!parts || !parts.length) {
      throw new Error('TIMEZONE_RESOLUTION_UNAVAILABLE');
    }
    var o = {};
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.type === 'year') o.year = parseInt(p.value, 10);
      if (p.type === 'month') o.month = parseInt(p.value, 10);
      if (p.type === 'day') o.day = parseInt(p.value, 10);
      if (p.type === 'hour') o.hour = parseInt(p.value, 10);
      if (p.type === 'minute') o.minute = parseInt(p.value, 10);
    }
    if (o.hour === 24) o.hour = 0;
    if (isNaN(o.year) || isNaN(o.month) || isNaN(o.day) ||
        isNaN(o.hour) || isNaN(o.minute)) {
      throw new Error('TIMEZONE_RESOLUTION_UNAVAILABLE');
    }
    return o;
  }

  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var TIME_RE = /^([0-2]\d):([0-5]\d)$/;

  /**
   * Convert a Paris local date + time to a UTC ISO timestamp.
   *
   * Offset discovery scans UTC J-1 → J+1 around the input date
   * to catch DST transitions that straddle midnight UTC.
   *
   * @param {string} dateStr — 'YYYY-MM-DD'
   * @param {string} timeStr — 'HH:MM' (24h, 00:00-23:59)
   * @returns {Object} result
   *   - {string} result.utcIso — ISO 8601 UTC string
   *   - {string} result.warning — 'AMBIGUOUS_FIRST_OCCURRENCE' if ambiguous
   *   - {string[]} result.candidates — all valid UTC candidates
   *   - {string} result.error — 'NONEXISTENT_TIME' | 'INVALID_INPUT' | 'TIMEZONE_RESOLUTION_UNAVAILABLE'
   */
  function parisToUtc(dateStr, timeStr) {
    var dm = DATE_RE.exec(dateStr);
    var tm = TIME_RE.exec(timeStr);
    if (!dm || !tm) {
      return { error: 'INVALID_INPUT' };
    }
    var iy = parseInt(dm[1], 10);
    var im = parseInt(dm[2], 10);
    var id = parseInt(dm[3], 10);
    var ih = parseInt(tm[1], 10);
    var imin = parseInt(tm[2], 10);

    // Validate calendar date is real (reject 2026-02-30 etc.)
    // Use UTC constructor to avoid local DST shift affecting validation.
    // Only validate year/month/day — hour/minute are validated by the
    // round-trip offset discovery below (which detects nonexistent times).
    var dateCheck = new Date(Date.UTC(iy, im - 1, id));
    if (dateCheck.getUTCFullYear() !== iy ||
        dateCheck.getUTCMonth() !== im - 1 ||
        dateCheck.getUTCDate() !== id) {
      return { error: 'INVALID_INPUT' };
    }

    // Step 1: Discover all Paris offsets in UTC window J-1 → J+1
    var offsets = {};
    for (var dayOffset = -1; dayOffset <= 1; dayOffset++) {
      var scanDate = new Date(iy, im - 1, id + dayOffset);
      var scanStr = scanDate.getFullYear() + '-' +
        pad2(scanDate.getMonth() + 1) + '-' +
        pad2(scanDate.getDate());
      for (var h = 0; h < 24; h++) {
        for (var m = 0; m < 60; m += 15) {
          var inst = new Date(scanStr + 'T' + pad2(h) + ':' + pad2(m) + ':00.000Z');
          try {
            var off = getParisOffsetMinutes(inst);
            offsets[off] = true;
          } catch (e) {
            return { error: 'TIMEZONE_RESOLUTION_UNAVAILABLE' };
          }
        }
      }
    }

    // Step 2: For each offset, compute candidate UTC and round-trip validate
    var candidates = [];
    for (var offMin in offsets) {
      if (!offsets.hasOwnProperty(offMin)) continue;
      var off = parseInt(offMin, 10);
      var localAsUtcMs = Date.parse(dateStr + 'T' + timeStr + ':00.000Z');
      if (isNaN(localAsUtcMs)) {
        return { error: 'INVALID_INPUT' };
      }
      var utcMs = localAsUtcMs - off * 60000;
      var utcDate = new Date(utcMs);
      try {
        var pp = getParisParts(utcDate);
        if (pp.year === iy && pp.month === im && pp.day === id &&
            pp.hour === ih && pp.minute === imin) {
          candidates.push({ utcIso: utcDate.toISOString(), offsetMin: off });
        }
      } catch (e) {
        return { error: 'TIMEZONE_RESOLUTION_UNAVAILABLE' };
      }
    }

    // Step 3: Apply policies
    if (candidates.length === 0) {
      return { error: 'NONEXISTENT_TIME' };
    }
    if (candidates.length === 1) {
      return {
        utcIso: candidates[0].utcIso,
        candidates: [candidates[0].utcIso]
      };
    }
    candidates.sort(function (a, b) {
      return a.utcIso < b.utcIso ? -1 : (a.utcIso > b.utcIso ? 1 : 0);
    });
    return {
      utcIso: candidates[0].utcIso,
      warning: 'AMBIGUOUS_FIRST_OCCURRENCE',
      candidates: candidates.map(function (c) { return c.utcIso; })
    };
  }

  /**
   * Convert a UTC ISO timestamp to Paris display parts.
   * @param {string} utcIso — ISO 8601 UTC string
   * @returns {Object} { date: 'DD/MM/YYYY', time: 'HH:MM', full: '...' }
   * Throws TIMEZONE_RESOLUTION_UNAVAILABLE on Intl failure.
   */
  function utcToParisDisplay(utcIso) {
    var d = new Date(utcIso);
    if (isNaN(d.getTime())) {
      throw new Error('INVALID_INPUT');
    }
    try {
      var dateStr = new Intl.DateTimeFormat('fr-FR', {
        timeZone: PARIS_TZ, day: '2-digit', month: '2-digit', year: 'numeric'
      }).format(d);
      var timeStr = new Intl.DateTimeFormat('fr-FR', {
        timeZone: PARIS_TZ, hour: '2-digit', minute: '2-digit', hour12: false
      }).format(d);
      var fullStr = new Intl.DateTimeFormat('fr-FR', {
        timeZone: PARIS_TZ, weekday: 'long', day: 'numeric', month: 'long',
        year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
      }).format(d);
      if (/^24:/.test(timeStr)) {
        timeStr = '00:' + timeStr.slice(3);
      }
      return { date: dateStr, time: timeStr, full: fullStr };
    } catch (e) {
      throw new Error('TIMEZONE_RESOLUTION_UNAVAILABLE');
    }
  }

  return {
    parisToUtc: parisToUtc,
    utcToParisDisplay: utcToParisDisplay,
    getParisOffsetMinutes: getParisOffsetMinutes,
    getParisParts: getParisParts,
    PARIS_TZ: PARIS_TZ
  };
})();

// Browser: set on window. Node: set on module.exports.
if (typeof window !== 'undefined') {
  window.ParisTZ = ParisTZ;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ParisTZ;
}
