'use strict';
// Dependency-injected lighting controller. No implicit connection or writes.
// Evidence: Smart Interior modules 1611/1612/1614, generated SOME/IP schema.
// Transport is supplied by the installed application; all writes require a request.
const IFACE = 'de.bmw.infotainment.misc.ComfortFunctionIuK';
const STATUS = 'statusAmbientLightInteriorColour';
const CONTROL = 'ambientLightInteriorColour';
const MENU = 'MenuAmbientePanoramicRoofInteriorLighting';
const BRIGHTNESS = 'BrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting';
const MODE = 'ModeAmbientePanoramicRoofInteriorLighting';
const MENU_VALUES = ['AMBIENTEBELEUCHTUNG_AUS'];
for (let i = 1; i <= 12; i++) MENU_VALUES.push('FARBAUSWAHL_' + i);
MENU_VALUES.push('INDIVIDUALMODUS', 'KOPPLUNG_AN_FES', 'SIGNAL_UNBEFUELLT');
const MODES = ['AUS', 'EIN', 'SIGNAL_UNBEFUELLT'];
const FIELDS = [
    ['HueInteriorLighting', 'HueInteriorLighting', 4095],
    [MENU, MENU, MENU_VALUES],
    ['HueValueLayer1IndividualGroup', 'HueValueLayer1IndividualGroup', 255],
    ['HueValueLayer2IndividualGroup', 'HueValueLayer2IndividualGroup', 255],
    ['HueValueLayer3IndividualGroup', 'HueValueLayer3IndividualGroup', 255],
    [BRIGHTNESS, BRIGHTNESS, 255],
    [MODE, MODE, MODES],
    ['DynamicInteriorLighting', 'DynamicInteriorLighting', MODES],
    // The extra 'i' is present in the actual status schema.
    ['DynamicAmbienteIinteriorLighting', 'DynamicAmbienteInteriorLighting', MODES],
];

function integer(value, low, high) {
    return Number.isInteger(value) && value >= low && value <= high;
}

function error(code, message) {
    const e = new Error(message); e.code = code; return e;
}

function copyToControl(status) {
    if (!status || typeof status !== 'object') throw error('INVALID_STATUS', 'No lighting status');
    const result = {};
    FIELDS.forEach(([from, to, allowed]) => {
        const value = status['status' + from];
        const valid = Array.isArray(allowed) ? allowed.indexOf(value) !== -1 : integer(value, 0, allowed);
        if (!valid) throw error('INVALID_STATUS', 'Invalid or missing field: status' + from);
        result['control' + to] = value;
    });
    // Preserve full 12-bit hue. Stock module 1611 maps it from layer1 instead;
    // that inconsistency remains an explicit issue for hardware validation.
    return result;
}

function decode(status) {
    copyToControl(status);
    const menu = MENU_VALUES.indexOf(status['status' + MENU]);
    const rawBrightness = status['status' + BRIGHTNESS];
    const mode = status['status' + MODE];
    return { profile: menu === 15 ? null : menu,
        brightnessOffset: rawBrightness === 255 ? null : rawBrightness - 127,
        enabled: mode === 'EIN' ? true : mode === 'AUS' ? false : null };
}

function validateChange(change, profiles) {
    if (!change || typeof change !== 'object' || Array.isArray(change) || !Object.keys(change).length)
        throw error('INVALID_CHANGE', 'Empty lighting change');
    Object.keys(change).forEach(key => {
        if (['profile', 'brightnessOffset', 'enabled'].indexOf(key) === -1)
            throw error('INVALID_CHANGE', 'Unsupported setting: ' + key);
    });
    if ('profile' in change && (!integer(change.profile, 1, 12) || profiles.indexOf(change.profile) === -1))
        throw error('UNVERIFIED_PROFILE', 'Profile not in the explicitly supplied supported list');
    if ('brightnessOffset' in change && !integer(change.brightnessOffset, -127, 127))
        throw error('INVALID_CHANGE', 'Brightness offset must be an integer from -127 to 127');
    if ('enabled' in change && typeof change.enabled !== 'boolean')
        throw error('INVALID_CHANGE', 'Enabled must be boolean');
    return Object.assign({}, change);
}

function monotonicMs() {
    if (typeof process !== 'undefined' && typeof process.hrtime === 'function') {
        const t = process.hrtime(); return t[0] * 1000 + t[1] / 1000000;
    }
    return Date.now();
}

function createController(transport, options) {
    if (!transport || typeof transport.get !== 'function' || typeof transport.set !== 'function')
        throw error('NO_TRANSPORT', 'An explicit transport is required');
    const profiles = ((options && options.supportedProfiles) || []).slice();
    const timeoutMs = options && options.timeoutMs !== undefined ? options.timeoutMs : 5000;
    const now = options && options.now ? options.now : monotonicMs;
    if (!integer(timeoutMs, 1, 60000)) throw error('INVALID_TIMEOUT', 'Invalid operation timeout');
    let busy = false, writeUncertain = false;
    function timed(action, cancel) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (cancel) cancel();
                reject(error('TIMEOUT', 'Lighting operation timed out'));
            }, timeoutMs);
            Promise.resolve().then(action).then(value => { clearTimeout(timer); resolve(value); },
                e => { clearTimeout(timer); reject(e); });
        });
    }
    return {
        validate: change => validateChange(change, profiles),
        async read() { return decode(await timed(() => transport.get(STATUS))); },
        async apply(change) {
            let requested;
            try { requested = validateChange(change, profiles); }
            catch (e) { e.writeState = 'not-dispatched'; throw e; }
            if (busy) { const e = error('BUSY', 'Another lighting change is pending'); e.writeState = 'not-dispatched'; throw e; }
            if (writeUncertain) throw error('WRITE_UNCERTAIN', 'Previous write outcome is unknown; no retry');
            busy = true;
            const token = { cancelled: false, dispatched: false, deadline: null };
            try {
                const before = await timed(() => transport.get(STATUS));
                const control = copyToControl(before), current = decode(before);
                if (Object.keys(requested).every(key => current[key] === requested[key]))
                    return { status: 'unchanged', observed: current };
                if (transport.guardedWrites !== true)
                    throw error('UNSAFE_TRANSPORT', 'Transport must enforce the dispatch lease at the native call');
                if ('profile' in requested) control['control' + MENU] = MENU_VALUES[requested.profile];
                if ('brightnessOffset' in requested) control['control' + BRIGHTNESS] = requested.brightnessOffset + 127;
                if ('enabled' in requested) control['control' + MODE] = requested.enabled ? 'EIN' : 'AUS';
                token.deadline = now() + timeoutMs;
                const lease = { dispatch(invoke) {
                    if (token.cancelled || now() >= token.deadline)
                        throw error('CANCELLED_BEFORE_DISPATCH', 'Lighting write expired before native dispatch');
                    if (token.dispatched) throw error('DUPLICATE_DISPATCH', 'Lighting write may only be dispatched once');
                    token.dispatched = true;
                    return invoke();
                } };
                await timed(() => transport.set(CONTROL, control, lease), () => { token.cancelled = true; });
                if (!token.dispatched) {
                    // A transport that promises guarding but ignores the lease is not trusted.
                    token.dispatched = true;
                    throw error('DISPATCH_NOT_CONFIRMED', 'Transport returned without a dispatch receipt');
                }
                let observed, matches = false;
                for (let attempt = 0; attempt < 4; attempt++) {
                    if (attempt) await new Promise(resolve => setTimeout(resolve, 250));
                    observed = decode(await timed(() => transport.get(STATUS)));
                    matches = Object.keys(requested).every(key => observed[key] === requested[key]);
                    if (matches) break;
                }
                writeUncertain = !matches;
                return { status: matches ? 'confirmed' : 'unconfirmed', observed };
            } catch (e) {
                if (token.dispatched) {
                    writeUncertain = true;
                    const wrapped = error('WRITE_UNCERTAIN', 'No confirmed result after lighting write: ' + e.message);
                    wrapped.cause = e; wrapped.writeState = 'unknown'; throw wrapped;
                }
                e.writeState = 'not-dispatched'; throw e;
            } finally { token.cancelled = true; busy = false; }
        },
    };
}

module.exports = { IFACE, STATUS, CONTROL, decode, copyToControl, createController };
