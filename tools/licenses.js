'use strict';
/**
 * app/LICENSE and app/NOTICE, which go into every package of the app, from the repository's own:
 *
 *   node tools/licenses.js          writes them
 *   node tools/licenses.js --check  says whether they are what it would write (the tests ask this)
 *
 * The kit packs two files of an app's folder that are not code: LICENSE and NOTICE, by those names. So the
 * app's LICENSE is both licences the package is under, one after the other: this project's (LICENSE at the
 * repository's top, MIT) and the emulator core's own licence file, in full (vendor/snes9x2005/copyright, which
 * is also LICENSE.snes9x2005 at the top). NOTICE is the repository's.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const RULE = '\n' + new Array(80).join('=') + '\n\n';

function texts() {
    const core = read('vendor/snes9x2005/copyright');
    return {
        'LICENSE.snes9x2005': core,
        'app/LICENSE': 'SNES for iDrive 7 is passed on under two licences. NOTICE, beside this file, says which part is under which.\n' +
            'Because of the second, the app as a whole is for non-commercial use only.\n' + RULE +
            '1. This project\'s own files\n\n' + read('LICENSE') + RULE +
            '2. The emulator core, snes9x2005 (snes.wasm and snes-plus.wasm): its own licence file, in full\n\n' + core,
        'app/NOTICE': read('NOTICE'),
    };
}

function main(check) {
    const t = texts();
    let differ = 0;
    Object.keys(t).forEach((f) => {
        const file = path.join(ROOT, f);
        const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
        if (have === t[f]) return;
        differ++;
        if (check) console.log('licenses: ' + f + ' is not what tools/licenses.js writes');
        else { fs.writeFileSync(file, t[f]); console.log('licenses: wrote ' + f); }
    });
    return differ;
}

module.exports = { texts };

if (require.main === module) {
    const check = process.argv.indexOf('--check') >= 0;
    const n = main(check);
    process.exit(check && n ? 1 : 0);
}
