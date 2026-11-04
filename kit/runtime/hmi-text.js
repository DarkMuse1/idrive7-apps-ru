'use strict';
// Chinese Unicode support: Bilibili 小白151 / GitHub JackieZ123430.
// RHMI Text is not a reliable Unicode transport on this firmware. Use the SDK's
// UTF-8 StringBundle and StringId handles for non-ASCII values instead.
const { t } = require('./i18n');
const SLOT_COUNT = 256; // HMI accepts at most 1024 strings, including all static menu resources.
const slotId = (n) => 'SID_CN_DYNAMIC_' + ('0000' + n).slice(-4);
const ascii = (s) => !/[^\x20-\x7e]/.test(s);
class HmiText {
    constructor(count) {
        this.count = count === undefined ? SLOT_COUNT : count;
        if (!Number.isInteger(this.count) || this.count < 1 || this.count > SLOT_COUNT) throw new RangeError('Invalid HMI text pool size');
        this.slots = new Map();
        this.free = [];
        this.next = 0;
        this.pending = new Map();
    }
    set(component, name, row, cell, value) {
        const key = JSON.stringify([name, row, cell]);
        // Serialize only this cell: an older StringId write must not overtake a newer
        // ASCII write and refer to a resource already recycled for another cell.
        const before = this.pending.get(key) || Promise.resolve();
        const work = before.then(() => this._set(component, name, row, cell, value, key));
        const cleanup = () => { if (this.pending.get(key) === settled) this.pending.delete(key); };
        const settled = work.then(cleanup, cleanup);
        this.pending.set(key, settled);
        return work;
    }
    _set(component, name, row, cell, value, key) {
        const text = t(value);
        if (ascii(text)) {
            const held = this.slots.get(key);
            return Promise.resolve(component.setValue(row, cell, text, 'Text')).then(value => {
                // Keep ownership on failure or while awaiting the actual HMI acknowledgement.
                if (held !== undefined) { this.slots.delete(key); this.free.push(held); }
                return value;
            });
        }
        let sid = this.slots.get(key);
        if (sid === undefined) {
            sid = this.free.length ? this.free.shift() : this.next < this.count ? slotId(this.next++) : null;
            if (sid === null) {
                // Replace stale text before reporting exhaustion; never overwrite another cell's id.
                const source = String(value == null ? '' : value);
                return Promise.resolve(component.setValue(row, cell, ascii(source) ? source : '', 'Text')).then(() => {
                    throw new Error('HMI text ids all in use (' + this.count + '): ' + name);
                });
            }
            this.slots.set(key, sid);
        }
        const bundle = component.getStringBundle();
        const strings = {}; strings[sid] = text;
        return Promise.resolve(bundle.setStrings(strings)).then(() => component.setValue(row, cell, sid, 'StringId'));
    }
}
module.exports = { HmiText, SLOT_COUNT, slotId };
