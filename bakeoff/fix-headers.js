'use strict';
/**
 * fix-headers.js - copies of test ROMs with a header every core takes.
 *
 *   node bakeoff/fix-headers.js <folder of .sfc> <folder for the copies>
 *
 * Many small test ROMs leave the header's ROM size byte at a value no cartridge has (krom's say 2 KB or 16 KB
 * for a 32 KB or 128 KB file). Snes9x 2005 and current Snes9x do not mind; snes9x2010 refuses such a file
 * ("ROM is corrupt or invalid": it wants the byte between 7 and 30). To put the same scene in front of every
 * core, the copy gets the size its file has (at least 7, 128 KB) and nothing else is touched. The copies are
 * for measuring only and stay in the git-ignored roms/.
 */
const fs = require('fs');
const path = require('path');
const { romInfo } = require('../app/snes-core');

const from = process.argv[2], to = process.argv[3];
if (!from || !to) { console.error('usage: node bakeoff/fix-headers.js <folder> <folder for the copies>'); process.exit(2); }
if (!fs.existsSync(to)) fs.mkdirSync(to);
let changed = 0, n = 0;
fs.readdirSync(from).filter((f) => /\.(sfc|smc)$/i.test(f)).forEach((f) => {
    const b = fs.readFileSync(path.join(from, f)), info = romInfo(b);
    if (!info) { console.log('not a game: ' + f); return; }
    n++;
    const at = info.at + 0x17, sram = info.at + 0x18;
    let size = 7;
    while ((1024 << size) < info.bytes) size++;
    if (b[at] < 7 || b[at] > 13) { b[at] = size; changed++; }
    if (b[sram] > 8) b[sram] = 0;
    fs.writeFileSync(path.join(to, f), b);
});
console.log(n + ' copies in ' + to + ', ' + changed + ' with the ROM size byte set');
