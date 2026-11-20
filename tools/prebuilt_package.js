'use strict';
/**
 * Hands the Store an app package its author built, byte for byte. Node 8.
 *
 * mgu-repo.json: "build": { "node": "tools/prebuilt_package.js", "args": ["{dir}"],
 *                           "output": "{dir}/{id}@{version}.tgz" }
 *
 * The app's folder holds <id>@<version>.tgz beside app.json, whose "package"
 * pins the file's size and SHA-256. The build checks them and writes nothing:
 * the output is the committed file.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function fail(why) {
    process.stderr.write(`${why}\n`);
    process.exit(1);
}

if (process.argv.length !== 3) {
    fail('usage: node tools/prebuilt_package.js <app folder, relative to the repo root>');
}
const folder = path.join(__dirname, '..', process.argv[2]);
const spec = JSON.parse(fs.readFileSync(path.join(folder, 'app.json'), 'utf8'));
const name = `${spec.id}@${spec.version}.tgz`;
const pin = spec.package || {};
let data;
try {
    data = fs.readFileSync(path.join(folder, name));
} catch (e) {
    // .gitattributes keeps a package out of the repository's source tarball; mgu-updater 0.8.40 and newer read the file itself
    fail(`${name} is not in ${process.argv[2]} (${e.code}): this copy of the repository leaves it out`);
}
const sha256 = crypto.createHash('sha256').update(data).digest('hex');
if (data.length !== pin.size || sha256 !== pin.sha256) {
    fail(`${name} (${data.length} bytes, sha256 ${sha256}) does not match the size and SHA-256 in app.json`);
}
console.log(`${name}: ${data.length} bytes, sha256 ${sha256}`);
