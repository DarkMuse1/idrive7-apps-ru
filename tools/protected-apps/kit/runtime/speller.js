'use strict';
// Native iDrive HMI full-screen speller (the car's own on-screen keyboard), reached
// through the SDK use-case factory (02076b22-…). Lets a kit app ask the driver for free
// text — e.g. an unlock password. The usecasemanagement proxies are already in every kit
// app's manifest (kit/tools/build.py PLATFORM_PROXIES), and ctx.app (an OnlineApp) exposes
// getUseCaseFactory() — the same path the official store uses for "Add source" / token.
//
// NOTE on masking: on iDrive7 the native speller shows the typed text (the store's token
// entry behaves the same on iDrive7 — only the iDrive8 drawn keyboard masks). So treat the
// returned value as sensitive, but expect it to be visible on screen as it is typed.
//
//   const speller = require('./kit/speller');
//   const text = await speller.prompt(ctx.app, { title: 'Пароль' });
//   // text: what the driver confirmed with OK, or null if they left without OK; throws if it won't open.

const USE_CASE = '02076b22-d19b-4aef-9e8c-0d7305d8b88c';
const PARAM = { title: 4, text: 102, ok: 105 }; // start / notify interaction-parameter ids
const CLOSED = ['ABORTED', 'FAILED', 'COMPLETED'];
const OPEN_TIMEOUT_MS = 10000;

const deadline = (ms, label) => new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out')), ms));

async function prompt(app, options) {
    const opts = options || {};
    const title = String(opts.title || '').slice(0, 22); // the HMI title shows at most 22 chars
    const factory = await Promise.race([
        Promise.resolve().then(() => app.getUseCaseFactory()),
        deadline(OPEN_TIMEOUT_MS, 'use case factory'),
    ]);
    const inst = await factory.create(USE_CASE);
    await inst.proxy.init();
    await inst.proxy.waitUntilAvailable();
    return new Promise((resolve, reject) => {
        let text = '', sub = null, settled = false;
        const settle = (err, value) => {
            if (settled) return;
            settled = true;
            Promise.resolve(sub !== null ? inst.proxy.notify.unsubscribe(sub) : undefined)
                .catch(() => { /* the instance is gone with the speller */ })
                .then(() => (err ? reject(err) : resolve(value)));
        };
        Promise.resolve(inst.proxy.notify.subscribe((n) => {
            const params = n && n.interactionParameters; // a Map-like object, not always a Map of this realm
            const has = (k) => !!params && typeof params.has === 'function' && params.has(k);
            if (has(PARAM.text)) text = String(params.get(PARAM.text));
            if (has(PARAM.ok)) settle(null, text);
            else if (n && CLOSED.indexOf(n.interactionState) >= 0) settle(null, null);
        }))
            .then((id) => {
                sub = id === undefined ? null : id;
                if (settled) return;
                return Promise.resolve(inst.proxy.interactionState.getValue()).then((state) => {
                    if (state !== 'READY') throw new Error('speller not READY (' + state + ')');
                    return inst.proxy.start({ token: inst.token, startParameters: new Map([[PARAM.title, title]]) });
                });
            })
            .catch(settle);
    });
}

module.exports = { prompt, USE_CASE };
