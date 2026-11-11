'use strict';
/**
 * datastate.js - is this app showing simulated data right now? (docs/architecture.md 3, TZ 7.4)
 *
 *   const datastate = require('./kit/datastate');
 *   datastate.setDemo('car', true);    // a demo source of this app went on (false: off again)
 *   datastate.isDemo()                 // true while any source is on
 *   datastate.onChange(fn)             // fn(isDemo, source, on) on every change; returns an unsubscribe
 *
 * One registry per app process. car.js registers its demo here, and so must any app-level demo
 * (a demo scan, simulated battery data...). While isDemo() the runtime itself draws the DEMO mark on
 * every frame (display.js) and on every home-screen widget (mgu.js), so no screen can show simulated
 * data unmarked. Node 8 compatible (runs on the head unit).
 */

const on = Object.create(null);          // source -> true while that source shows demo data
const listeners = [];

function setDemo(source, demo) {
    source = String(source);
    demo = !!demo;
    if (!!on[source] === demo) return;
    if (demo) on[source] = true; else delete on[source];
    const now = isDemo();
    listeners.slice().forEach((fn) => { try { fn(now, source, demo); } catch (e) { /* a listener's problem stays its own */ } });
}

function isDemo() { return Object.keys(on).length > 0; }

/** Sources that show demo data now. */
function sources() { return Object.keys(on); }

function onChange(fn) {
    listeners.push(fn);
    return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
}

module.exports = { setDemo, isDemo, sources, onChange };
