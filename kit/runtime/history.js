'use strict';
// Validate the existing JSON history formats before the UI reads nested records.
// Extra fields are preserved; empty older files may omit top-level collections.
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const number = v => typeof v === 'number' && isFinite(v);
const nonnegative = v => number(v) && v >= 0;
const map = (v, check) => object(v) && Object.keys(v).every(k => check(v[k]));
const optional = (v, k, check) => v[k] === undefined || check(v[k]);
const list = (v, check) => Array.isArray(v) && v.every(check);
const fields = (v, names, check) => object(v) && names.every(k => check(v[k]));

const dragBest = v => object(v) && nonnegative(v.s) && optional(v, 'trap', nonnegative);
const dragRun = v => object(v) && number(v.at) && map(v.result, nonnegative)
    && optional(v, 'trap', x => map(x, nonnegative));
const brakeResult = v => fields(v, ['m', 's'], nonnegative);
const brakeRun = v => object(v) && number(v.at) && map(v.result, brakeResult)
    && nonnegative(v.peakG) && nonnegative(v.vStart) && object(v.newBest)
    && list(v.trace, p => Array.isArray(p) && p.length >= 3 && nonnegative(p[0])
        && nonnegative(p[1]) && (p[2] === null || number(p[2])));
const dynoRun = v => fields(v, ['at', 'peakP', 'peakPrpm', 'peakT', 'peakTrpm', 'weight', 'loss', 'v0', 'v1'], number)
    && Array.isArray(v.curve) && v.curve.length > 0
    && v.curve.every(p => fields(p, ['rpm', 'p', 't'], nonnegative)
        && (p.ecu === undefined || p.ecu === null || number(p.ecu)));

module.exports = {
    drag: v => object(v) && optional(v, 'best', x => map(x, dragBest)) && optional(v, 'runs', x => list(x, dragRun)),
    brake: v => object(v) && optional(v, 'best', x => map(x, brakeResult)) && optional(v, 'runs', x => list(x, brakeRun)),
    dyno: v => object(v) && optional(v, 'runs', x => list(x, dynoRun))
        && optional(v, 'baseline', x => x === null || dynoRun(x)),
    gforce: v => map(v, x => object(x) && nonnegative(x.v) && number(x.at)),
};
