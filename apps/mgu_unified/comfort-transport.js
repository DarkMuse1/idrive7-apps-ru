'use strict';
// App-local native queue. Every write checks its controller lease inside the
// final native tick; a completed/cancelled request cannot be revived later.
function create(proxyPromise, options) {
    const tick = options && options.tick ? options.tick : setImmediate;
    let chain = Promise.resolve(), closed = false;
    function enqueue(action) {
        const result = chain.then(() => Promise.resolve(proxyPromise)).then(p => new Promise((resolve, reject) => {
            tick(() => {
                try {
                    if (closed) throw new Error('Lighting transport is closed');
                    Promise.resolve(action(p)).then(resolve, reject);
                } catch (e) { reject(e); }
            });
        }));
        // A late native completion must settle before the next actual RPC.
        chain = result.catch(() => {});
        return result;
    }
    return {
        guardedWrites: true,
        get: field => enqueue(p => p.getValue(field)),
        set: (field, value, lease) => {
            if (!lease || typeof lease.dispatch !== 'function')
                return Promise.reject(new Error('Dispatch lease required'));
            return enqueue(p => lease.dispatch(() => p.setValue(field, value, 5000)));
        },
        close() { closed = true; },
    };
}
module.exports = { create };
