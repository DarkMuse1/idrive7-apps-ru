'use strict';
// Parse the module table as syntax. Never evaluate the downloaded prelude or
// factories on the PC, even if the file starts with the Browserify signature.
const acorn = require('./vendor/acorn/acorn');
module.exports = function parse(text) {
    if (Buffer.byteLength(text, 'utf8') > 32 * 1024 * 1024) throw new Error('SDK bundle too large');
    const ast = acorn.parse(text, { ecmaVersion: 2018 });
    if (ast.body.length !== 1 || ast.body[0].type !== 'ExpressionStatement') throw new Error('Unexpected bundle statements');
    const call = ast.body[0].expression;
    if (call.type !== 'CallExpression' || call.arguments.length !== 3 || call.arguments[0].type !== 'ObjectExpression') throw new Error('Missing module table');
    const mods = Object.create(null);
    for (const p of call.arguments[0].properties) {
        if (p.type !== 'Property' || p.computed || p.kind !== 'init' || p.method || p.key.type !== 'Literal' || !Number.isSafeInteger(Number(p.key.value))) throw new Error('Invalid module ID');
        const id = String(p.key.value), pair = p.value;
        if (!/^(0|[1-9][0-9]*)$/.test(id)) throw new Error('Noncanonical module ID');
        if (Object.prototype.hasOwnProperty.call(mods, id) || pair.type !== 'ArrayExpression' || pair.elements.length !== 2) throw new Error('Duplicate or malformed module');
        const fn = pair.elements[0], deps = pair.elements[1];
        if (!fn || fn.type !== 'FunctionExpression' || fn.async || fn.generator || !deps || deps.type !== 'ObjectExpression') throw new Error('Invalid module factory');
        const map = Object.create(null);
        for (const d of deps.properties) {
            // Browserify leaves native Node dependencies (fs/events/etc.) undefined.
            // Accept that syntax only; never evaluate identifiers or expressions.
            const external = d.value && d.value.type === 'Identifier' && d.value.name === 'undefined';
            const literal = d.value && d.value.type === 'Literal' && ['number','string'].includes(typeof d.value.value);
            if (d.type !== 'Property' || d.computed || d.kind !== 'init' || d.method || !['Literal','Identifier'].includes(d.key.type) || (!external && !literal)) throw new Error('Invalid dependency');
            const key = d.key.type === 'Identifier' ? d.key.name : String(d.key.value);
            if (key === '__proto__' || Object.prototype.hasOwnProperty.call(map, key)) throw new Error('Duplicate dependency');
            map[key] = external ? undefined : d.value.value;
        }
        mods[id] = [{ toString: () => text.slice(fn.start, fn.end) }, map];
    }
    return mods;
};
