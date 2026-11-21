'use strict';
/**
 * The bundled cartridge, app/games/Pad_Test.sfc, from games/src: needs cc65's ca65 and ld65, and Node.js.
 *
 *   node games/build.js        (npm run build:games)
 *
 * ca65 and ld65 are taken from the PATH (`apt install cc65`, `brew install cc65`, https://cc65.github.io), or
 * from .cache/cc65/bin, where `node tools/cc65.js` builds them from cc65's source on a computer without them.
 * The file it writes is committed, so the app builds without cc65. A build gives the same bytes.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const cc65 = require('../tools/cc65');
const chr = require('./mkchr');

const HERE = __dirname, OBJ = path.join(HERE, 'obj'), OUT = path.join(HERE, '..', 'app', 'games');

/** the header's checksum and its complement: the sum of every byte of the ROM (app/snes-core.js weighs them) */
function sign(rom, at) {
    rom[at + 0x1c] = 0xff; rom[at + 0x1d] = 0xff; rom[at + 0x1e] = 0; rom[at + 0x1f] = 0;
    let sum = 0;
    for (let i = 0; i < rom.length; i++) sum = (sum + rom[i]) & 0xffff;
    rom[at + 0x1e] = sum & 255; rom[at + 0x1f] = sum >> 8;
    rom[at + 0x1c] = ~sum & 255; rom[at + 0x1d] = (~sum >> 8) & 255;
    return rom;
}

function build(source, name) {
    const tools = cc65.find();
    if (!tools) throw new Error('ca65 and ld65 (the cc65 package) are needed: apt install cc65, brew install cc65, or node tools/cc65.js');
    [OBJ, OUT].forEach((d) => { if (!fs.existsSync(d)) fs.mkdirSync(d); });
    const tiles = chr.build();
    fs.writeFileSync(path.join(OBJ, 'font.bin'), tiles.font);
    fs.writeFileSync(path.join(OBJ, 'ball.bin'), tiles.ball);
    const run = (cmd, args) => {
        const r = spawnSync(cmd, args, { cwd: HERE, stdio: 'inherit' });
        if (r.status !== 0) throw new Error(path.basename(cmd) + ' failed');
    };
    const obj = path.join('obj', source + '.o'), raw = path.join('obj', source + '.sfc');
    run(tools[0], ['--cpu', '65816', '-I', 'src', '--bin-include-dir', 'obj', '-o', obj, path.join('src', source + '.s')]);
    run(tools[1], ['-C', path.join('src', 'lorom.cfg'), '-o', raw, obj]);
    const rom = sign(fs.readFileSync(path.join(HERE, raw)), 0x7fc0);
    if (rom.length !== 131072) throw new Error('the cartridge is ' + rom.length + ' bytes, not 128 KB');
    fs.writeFileSync(path.join(OUT, name + '.sfc'), rom);
    console.log('build: app/games/' + name + '.sfc, ' + rom.length + ' bytes');
}

if (require.main === module) {
    try { build('pad_test', 'Pad_Test'); } catch (e) { console.error('build: ' + e.message); process.exit(1); }
}
module.exports = { sign };
