'use strict';
/**
 * clock.js - the one place the runtime reads time (docs/architecture.md 2 rule 7, section 4).
 *
 *   const clock = require('./kit/clock');
 *   clock.now()    monotonic milliseconds (process.hrtime): ages, intervals, sample times. Its zero is
 *                  arbitrary, so only differences mean anything - never compare it with wall()
 *   clock.wall()   Date.now(): dates in logs and history only. The head unit sets its clock after
 *                  start-up, so wall time can jump by hours in either direction
 *   clock.setTimeout / clearTimeout / setInterval / clearInterval: the timers for the runtime's
 *                  periodic work
 *
 * Every call looks up process.hrtime, Date.now and the global timers at call time, so a replay stand
 * that replaces those globals drives this module too. Tests can also replace any part directly:
 *   clock.use({ now: () => t, wall: () => w })     // missing parts stay real
 *   clock.use(null)                                 // back to the real clock
 * Node 8 compatible (runs on the head unit).
 */

const real = {
    now: () => { const t = process.hrtime(); return t[0] * 1e3 + t[1] / 1e6; },
    wall: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
};
let cur = real;

module.exports = {
    now: () => cur.now(),
    wall: () => cur.wall(),
    setTimeout: (fn, ms) => cur.setTimeout(fn, ms),
    clearTimeout: (h) => cur.clearTimeout(h),
    setInterval: (fn, ms) => cur.setInterval(fn, ms),
    clearInterval: (h) => cur.clearInterval(h),
    /** Replace parts of the clock (tests, replay); null restores the real one. */
    use(impl) { cur = impl ? Object.assign({}, real, impl) : real; },
};
