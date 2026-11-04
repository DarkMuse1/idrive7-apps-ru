(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.MguVitals = factory();
}(this, function () {
    'use strict';
    // Settings semantics of apps/car_vitals 2.14.0 applied to the unified layout. Display only:
    // no source is invented; 'auto' shows a value once this source actually delivered it.
    var finite = function (v) { return typeof v === 'number' && isFinite(v); };
    /** boostMax setting -> the boost bar's end in bar and in psi (upstream 96c664d; default 2.5 bar / 36 psi = 5389acc). */
    var BOOST_MAX = { '2.0': [2, 30], '2.5': [2.5, 36], '3.0': [3, 44], '3.5': [3.5, 50] };
    var TORQUE = { nm: 1, lbft: 0.737562, kgm: 1 / 9.80665 };          // the car sends Nm (1 Nm = 0.737562 lb-ft = 1 / 9.80665 kgm)
    var SHOW = { boost: 'showBoost', gearbox: 'showGearbox', egs: 'showEgs', iat: 'showIat', hpfp: 'showHpfp', lpfp: 'showLpfp',
        timing: 'showTiming', misfire: 'showMisfire', tyres: 'showTyres', tyreTemp: 'showTyreTemp' };
    var PAGES = { engine: 0, thermal: 1, fuel: 3, chassis: 4 };
    var TRACKED = ['rpm', 'boost', 'torque', 'oil', 'coolant', 'transmission', 'ambient', 'intake', 'hpfp', 'lpfp', 'timing', 'frontTorque', 'speed', 'powerPct',
        'tireFL', 'tireFR', 'tireRL', 'tireRR', 'tireTempFL', 'tireTempFR', 'tireTempRL', 'tireTempRR'];
    function Tracker() { this.key = null; this.reset(); }
    Tracker.prototype.reset = function () { this.seen = {}; this.peaks = {}; this.peakAt = {}; };
    // A new source never inherits what the previous one delivered (checked on update AND on display).
    Tracker.prototype.sync = function (feed) { var key = feed.mode + ':' + feed.revision; if (key !== this.key) { this.key = key; this.reset(); } };
    // Peak hold as in apps/car_vitals raise(): follows new highs; peakHold s after the last raise it
    // drops back to the current value.
    Tracker.prototype.update = function (feed, prefs, now) {
        var self = this;
        this.sync(feed);
        if (feed.mode === 'offline') return;
        TRACKED.forEach(function (k) {
            var s = feed.read(k), v = s.value;
            if (!finite(v)) return;
            self.seen[k] = s.source || true;
            if (k === 'transmission') self.seen[/UDS|EGS|egs/.test(String(s.source)) ? 'egs' : 'gearbox'] = true;
            var hold = prefs.peakHold * 1000;
            if (self.peaks[k] === undefined || v >= self.peaks[k] || hold > 0 && now - (self.peakAt[k] || 0) > hold) { self.peaks[k] = v; self.peakAt[k] = now; }
        });
    };
    var GROUP_KEY = { boost: 'boost', gearbox: 'gearbox', egs: 'egs', iat: 'intake', hpfp: 'hpfp', lpfp: 'lpfp', timing: 'timing', tyres: 'tireFL', tyreTemp: 'tireTempFL' };
    function shown(tracker, prefs, group, mode) {
        var s = prefs[SHOW[group]];
        if (s === 'on') return true;
        if (s === 'off') return false;
        // misfire counters are read only on request, so 'auto' keeps the entry visible
        return group === 'misfire' || mode === 'demo' || !!tracker.seen[GROUP_KEY[group]];
    }
    function xdriveShown(tracker, prefs, mode) { return prefs.xdrive === 'on' || prefs.xdrive !== 'off' && (mode === 'demo' || !!tracker.seen.frontTorque); }
    var conv = {
        temp: function (p, v) { return finite(v) ? p.tempUnit === 'F' ? v * 9 / 5 + 32 : v : null; },
        press: function (p, v) { return finite(v) ? p.pressUnit === 'psi' ? v * 14.5038 : v : null; },
        power: function (p, v) { return finite(v) ? v * ({ kw: 1, hp: 1.34102, ps: 1.35962 }[p.powerUnit] || 1) : null; },
        torque: function (p, v) { return finite(v) ? v * (TORQUE[p.torqueUnit] || 1) : null; }
    };
    function units(p) { return { temp: p.tempUnit === 'F' ? '°F' : '°C', press: p.pressUnit === 'psi' ? 'psi' : 'bar', power: { kw: 'кВт', hp: 'hp', ps: 'PS' }[p.powerUnit] || 'кВт', torque: { nm: 'Н·м', lbft: 'lb-ft', kgm: 'кгс·м' }[p.torqueUnit] || 'Н·м' }; }
    /**
     * End of the torque bar: kgm - the setting "Шкала момента в кгс·м" as it is (default 100 = the Nm scale end
     * in kgm: 900 Nm = 91.8 kgm, rounded up); Nm / lb-ft - 900 Nm in the unit shown (the kgm setting is ignored).
     */
    function torqueMax(p) { return p.torqueUnit === 'kgm' ? (finite(p.maxTorqueKgm) && p.maxTorqueKgm > 0 ? p.maxTorqueKgm : 100) : conv.torque(p, 900); }
    /** End of the boost bar in the unit shown; a value the setting does not offer reads as the default. */
    function boostMax(p) { var b = BOOST_MAX[p.boostMax] || BOOST_MAX['2.5']; return p.pressUnit === 'psi' ? b[1] : b[0]; }
    /** rpm bar end and redline: the engine profile (Telemetry.limits), else the petrol profile. */
    function rpmLimits(p, limits) {
        if (limits && limits.car_vitals) return { redline: limits.car_vitals.redline, scaleMax: limits.scaleMax };
        return { redline: Math.min(finite(p.redline) && p.redline > 0 ? p.redline : 7000, 8000), scaleMax: 8000 };
    }
    /** Power in kW: the sport display's percentage of maxPower, or torque x rpm (calc). */
    function power(feed, p) {
        var pct = feed.read('powerPct').value, t = feed.read('torque').value, rpm = feed.read('rpm').value;
        if (p.powerSource !== 'calc' && finite(pct)) return { kw: pct / 100 * p.maxPower, calc: false };
        return { kw: finite(t) && finite(rpm) ? Math.max(0, t * rpm / 9549) : null, calc: true };
    }
    function boost(feed, p) {
        var s = feed.read('boost'), computed = /^computed:UDS/.test(String(s.source));
        if (p.boostSource === 'fes' && computed || p.boostSource === 'dme' && !computed) return { value: null, why: p.boostSource === 'fes' ? 'Нет показания FES' : 'Нет расчёта DME' };
        return { value: s.value, computed: computed };
    }
    /**
     * Cells of one tab: { label, value (display units), unit, digits, tone, peak, sub, max, mark }. max = the end of
     * the bar where the original app has a fixed gauge (rpm: the scale of the engine profile; torque; boost), mark =
     * its red line / warning mark (rpm: the redline, boost: 85 % of the gauge). limits = Telemetry.limits().
     */
    function view(tab, feed, prefs, tracker, mode, limits) {
        tracker.sync(feed); var u = units(prefs), out = [], P = prefs, RL = rpmLimits(P, limits), tqDigits = P.torqueUnit === 'kgm' ? 1 : 0;
        var cell = function (label, key, value, unit, digits, tone, convert, extra) {
            var pk = P.peaks && tracker.peaks[key] !== undefined ? (convert ? convert(P, tracker.peaks[key]) : tracker.peaks[key]) : null;
            var c = { key: key, label: label, value: value, unit: unit, digits: digits || 0, tone: tone || null, peak: pk };
            if (extra) Object.keys(extra).forEach(function (k) { c[k] = extra[k]; });
            out.push(c);
        };
        var raw = function (k) { return feed.read(k).value; };
        var torqueBar = { max: torqueMax(P) };
        if (tab === 0) {
            var rpm = raw('rpm'), pw = power(feed, P), oil = raw('oil');
            cell('Обороты', 'rpm', rpm, 'об/мин', 0, finite(rpm) && rpm >= RL.redline ? 'crit' : null, null, { max: RL.scaleMax, mark: RL.redline, markTone: 'crit' });
            out.push({ label: pw.calc ? 'Мощность · расчёт M×n' : 'Мощность · спорт-индикатор', value: conv.power(P, pw.kw), unit: u.power, digits: 0, tone: null, peak: null });
            cell('Момент ECU', 'torque', conv.torque(P, raw('torque')), u.torque, tqDigits, null, conv.torque, torqueBar);
            if (shown(tracker, P, 'boost', mode)) {
                var b = boost(feed, P), bv = conv.press(P, b.value), bmax = boostMax(P);
                out.push({ label: b.computed ? 'Наддув · DME, расчёт' : 'Наддув · индикация', value: bv, unit: u.press, digits: P.pressUnit === 'psi' ? 1 : 2,
                    tone: finite(bv) && bv >= bmax * 0.85 ? 'warn' : null, peak: P.peaks && tracker.peaks.boost !== undefined ? conv.press(P, tracker.peaks.boost) : null,
                    max: bmax, mark: bmax * 0.85, markTone: 'warn' });
            }
            cell('Температура масла', 'oil', conv.temp(P, oil), u.temp, 0, finite(oil) && oil >= P.oilWarn ? 'crit' : null, conv.temp);
        } else if (tab === 1) {
            var o = raw('oil'), c = raw('coolant'), tr = feed.read('transmission'), egs = /UDS|EGS|egs/.test(String(tr.source));
            cell('Масло', 'oil', conv.temp(P, o), u.temp, 0, finite(o) && o >= P.oilWarn ? 'crit' : null, conv.temp);
            cell('ОЖ', 'coolant', conv.temp(P, c), u.temp, 0, finite(c) && c >= 112 ? 'crit' : null, conv.temp);
            if (shown(tracker, P, egs ? 'egs' : 'gearbox', mode)) cell(egs ? 'Коробка · EGS' : 'Трансмиссия · индикация', 'transmission', conv.temp(P, tr.value), u.temp, 0, finite(tr.value) && tr.value >= 120 ? 'warn' : null, conv.temp);
            cell('Снаружи', 'ambient', conv.temp(P, raw('ambient')), u.temp, 0, null, conv.temp);
        } else if (tab === 3) {
            if (shown(tracker, P, 'hpfp', mode)) cell('Топливо · высокое давление', 'hpfp', conv.press(P, raw('hpfp')), u.press, P.pressUnit === 'psi' ? 0 : 1, null, conv.press);
            if (shown(tracker, P, 'lpfp', mode)) cell('Топливо · низкое давление', 'lpfp', conv.press(P, raw('lpfp')), u.press, 1, null, conv.press);
            if (shown(tracker, P, 'iat', mode)) cell('Температура впуска', 'intake', conv.temp(P, raw('intake')), u.temp, 0, null, conv.temp);
            if (shown(tracker, P, 'timing', mode)) cell('Угол зажигания', 'timing', raw('timing'), '°', 0);
        } else if (tab === 4) {
            if (xdriveShown(tracker, P, mode)) cell('Передняя ось · показание LMV', 'frontTorque', conv.torque(P, raw('frontTorque')), u.torque, tqDigits, null, conv.torque, torqueBar);
            cell('Передача', 'gear', raw('gear'), '', 0);
            cell('Момент двигателя', 'torque', conv.torque(P, raw('torque')), u.torque, tqDigits, null, conv.torque, torqueBar);
            cell('Скорость', 'speed', raw('speed'), 'км/ч', 0);
        }
        return out;
    }
    function tyres(feed, prefs, tracker, mode) {
        tracker.sync(feed); var u = units(prefs);
        return { shown: shown(tracker, prefs, 'tyres', mode), temps: shown(tracker, prefs, 'tyreTemp', mode), unit: u.press, tempUnit: u.temp,
            wheels: ['FL', 'FR', 'RL', 'RR'].map(function (w) { return { wheel: w, press: conv.press(prefs, feed.read('tire' + w).value), temp: conv.temp(prefs, feed.read('tireTemp' + w).value), target: conv.press(prefs, feed.read('tireTarget' + w).value) }; }) };
    }
    return { Tracker: Tracker, view: view, tyres: tyres, shown: shown, xdriveShown: xdriveShown, power: power, PAGES: PAGES, SHOW: SHOW, conv: conv,
        BOOST_MAX: BOOST_MAX, torqueMax: torqueMax, boostMax: boostMax, rpmLimits: rpmLimits };
}));
