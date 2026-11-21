# The bake-off: which SNES core, and is it fast enough?

Measured on 2026-11-20. **Everything here ran on a PC. Nothing here has been on a car.**

| | |
|---|---|
| The PC | AMD Ryzen 7 9800X3D, Windows 11 |
| What ran the WebAssembly | Node 8.17.0 (the head unit has 8.16.2), one process per run, one at a time |
| The build | the NES project's recipe: zig 0.13.0 for `wasm32-wasi`, `-mcpu=mvp -mexec-model=reactor`, binaryen 119's `wasm-opt` (`--signext-lowering --legalize-js-interface --strip-debug`), the frontend `core/mgu_libretro.c` unchanged but for the game's name, the memory at its full size from the start, a 2 MiB stack |
| How it was run | through `app/snes-core.js`, as the app will run it: pad in, one frame, the picture as RGBA out |
| The games | free test ROMs only (below). **None of the owner's games yet, so no commercial game, and no real SuperFX or SA-1 game.** |

## The answer so far

- **snes9x2005 costs about what the NES core costs.** On this PC a frame of the NES app's FCEUmm takes 0.26 ms (`bakeoff/nes-baseline.js`: Snake and Pad Test, Node 8). snes9x2005 takes 0.16 to 0.52 ms on the scenes without a special chip, and 1.3 ms on the SuperFX one.
- **snes9x2010 and current Snes9x cost two to three times that,** more in high resolution (2010: seven times) and with the SuperFX (current: 2.7 times, with single frames of 12 to 16 ms on this PC).
- **`-Os` or `-O2` makes no difference to speed** worth the name here (within a tenth, either way), unlike for the NES core. `-Os` is smaller and compiles faster, so `-Os`.
- **Node 8 compiles snes9x2005 as fast as the NES core** (54 ms here against 66 ms); 2010 takes six times as long, current Snes9x thirteen times.
- **The two cores that are not Snes9x do not get there.** Supafaust (GPL) as libretro has it always draws on a second thread, needs C++ exceptions, and on one thread (a one-line measuring variant) is 2.3 to 5 times slower than snes9x2005 as a native program. LakeSnes (MIT) is 7 to 13 times slower than snes9x2005 as a native program and has no special chips at all.
- **How many times slower the head unit is, nobody has measured.** The NES app on the car already writes the number that tells (see [The car](#the-car)).

## The cores

`bakeoff/cores.js` has each one's repository, commit and file list. Licences as their own files say, read on 2026-11-20:

| Core | Commit | What it is | Licence |
|---|---|---|---|
| `libretro/snes9x2005` | `a79dfe9` | Snes9x 1.43, C, by way of the DS ports | its `copyright` file: Snes9x's (non-commercial), **and** GPL-2.0-or-later notices for the DS port (ndssfc) and for ZSNES code, and MIT for libretro's own part |
| the same, "plus" | `a79dfe9` | with blargg's sound chip in place of Snes9x 1.43's (`USE_BLARGG_APU`) | the same |
| `libretro/snes9x2010` | `82904a9` | Snes9x 1.52, C | `LICENSE.txt`: Snes9x's (non-commercial) |
| `libretro/snes9x` | `204ea1c` | current Snes9x, C++ and C | `LICENSE`: Snes9x's (non-commercial) |
| `libretro/snes9x2002` | `6ffbf9e` | Snes9x 1.39, C (not in the brief; here as the lightest there is) | Snes9x's, in the file headers |
| `libretro/supafaust` | `642d1d1` | Mednafen's snes_faust, C++ | GPL-2.0-or-later (`COPYING`, file headers) |
| `angelo-wf/LakeSnes` | `9db90b8` | small, C, archived | MIT |

bsnes and Mesen were not built: accuracy first, and slower again than anything here.

## What each took to build

- **snes9x2005, its plus variant, snes9x2010, snes9x2002:** built as they are with the NES recipe. Nothing changed in any of them.
- **Current Snes9x:** zig 0.13 cannot build its C++ library for `wasm32-wasi` at all (it compiles the library's thread sources for a target without threads; a three-line program fails the same way). **zig 0.14.1 can**, with two differences: it reads `--initial-memory` as a decimal number, and its emulated process clocks do not build (left out: `EMULATE="signal mman getpid"`). So this core would mean leaving the kit's toolchain version for the core. With that it builds unchanged, without exceptions (`-fno-exceptions`), and runs under Node 8.
- **Supafaust:** not built to WebAssembly. Its code throws C++ exceptions (124 `throw`, 20 `try`), which the first version of WebAssembly cannot do, and libretro's port sets the two-thread renderer after reading the option (`libretro.cpp`: `MDFNI_SetSetting("snes_faust.renderer", "mt")`), so the option `st` does nothing. It would need changes to its source for both. Measured as a native program only, with that one line taken out (`supafaust_st` in `cores.js`).
- **LakeSnes:** no libretro port; timed with a small program of its own (`bakeoff/lakesnes_time.c`).
- **snes9x2010 refuses most small test ROMs** ("ROM is corrupt or invalid"): it wants the header's ROM size byte between 7 and 30, and most of krom's ROMs say less (79 of the 80 fetched). The others take them. The measurements use copies with that one byte set (`bakeoff/fix-headers.js`); a real cartridge's header has it right.
- **A C library stub the NES app did not need:** snes9x2010 calls `getenv`, and the C library ends the program when it cannot ask for the environment. `app/snes-core.js` now answers "no arguments, no environment".

## Speed under Node 8

Milliseconds a frame: mean (99th percentile, worst), over 2700 frames after 300 to warm up. `-Os` builds; the `-O2` ones are in the last table. `node bakeoff/run.js`, results in `.cache/bakeoff/results/matrix.jsonl`.

| scene | 2002 | 2005 | 2005 plus | 2010 | current Snes9x |
|---|---|---|---|---|---|
| Mode 7 text scroll (StarWars) | 0.27 (0.46, 1.17) | 0.28 (0.40, 1.08) | 0.49 (0.79, 1.61) | 0.86 (1.30, 1.74) | 0.86 (1.37, 1.96) |
| **SuperFX** polygons (GSU FillPoly 8 bpp) | 1.38 (2.02, 2.43) | 1.34 (1.85, 2.46) | 1.49 (2.04, 2.59) | 2.54 (3.83, 4.63) | 3.67 (12.34, 16.62) |
| **512 x 448** picture (InterlaceRPG) | *0.19: draws 256 x 224* | 0.52 (0.64, 1.02) | 0.66 (0.90, 1.76) | 1.66 (2.54, 2.77) | 0.97 (1.62, 2.99) |
| **512 x 448**, mode 5 with mosaic | *0.13: draws 256 x 224* | 0.46 (0.63, 0.89) | 0.64 (0.83, 1.48) | 3.35 (5.31, 6.02) | 1.54 (1.85, 2.66) |
| a colour change every line (HDMA HiColor) | 0.31 (0.53, 0.81) | 0.31 (0.51, 1.29) | 0.47 (0.59, 1.35) | 0.63 (0.94, 2.76) | 0.63 (0.84, 1.39) |
| colour blending (Blend HiColor) | 0.32 (0.38, 0.72) | 0.31 (0.37, 1.19) | 0.43 (0.66, 1.28) | 0.55 (0.69, 1.08) | 0.60 (0.75, 1.15) |
| a small Mode 7 game (MonsterFarmJump) | 0.17 (0.24, 0.92) | 0.24 (0.49, 1.08) | 0.43 (0.71, 1.19) | 0.47 (0.70, 0.96) | 0.56 (0.91, 1.24) |
| music, a still picture (Axel-F) | 0.15 (0.22, 0.97) | 0.16 (0.27, 0.47) | 0.26 (0.31, 1.08) | 0.27 (0.35, 1.11) | 0.32 (0.56, 1.18) |
| **SA-1** at work (SnesSpeedTest 5.1) | 0.38 (0.65, 1.15) | 0.35 (0.65, 1.20) | 0.48 (0.78, 1.26) | 0.70 (1.00, 1.56) | 0.87 (1.39, 1.71) |
| *for comparison: the NES app's core, Snake* | | *0.26* | | | |

The worst frames near 1 ms that every build shows on nearly every scene are most likely this PC's and not the cores': one frame in a few thousand, and as long on the lightest scene as on a heavy one.

**These scenes are lighter than a commercial game.** A test ROM draws one thing; a game runs its logic, four layers, sprites and its music at once. The SuperFX and SA-1 scenes do keep those chips busy, but a game adds the rest on top. The owner's games are needed for the heavy end.

### Per build

| build | `.wasm` | Node 8 compiles it in | memory, all from the start | the process holds | a save state | saving one |
|---|---|---|---|---|---|---|
| snes9x2002 `-Os` | 0.62 MB | 46 - 50 ms | 28 MiB | 59 MB | 431 KB | 0.13 ms |
| snes9x2002 `-O2` | 0.73 MB | 54 - 73 ms | 28 MiB | 59 MB | | |
| **snes9x2005 `-Os`** | **0.61 MB** | **53 - 55 ms** | **24 MiB** | **57 MB** | **529 KB** | **0.10 ms** |
| snes9x2005 `-O2` | 0.70 MB | 66 - 71 ms | 24 MiB | 58 MB | | |
| snes9x2005 plus `-Os` | 0.54 MB | 47 - 50 ms | 24 MiB | 57 MB | 532 KB | 0.11 ms |
| snes9x2005 plus `-O2` | 0.63 MB | 58 - 63 ms | 24 MiB | 58 MB | | |
| snes9x2010 `-Os` | 2.56 MB | 323 - 356 ms | 32 MiB | 76 MB | 827 KB | 0.20 ms |
| snes9x2010 `-O2` | 2.89 MB | 424 - 452 ms | 32 MiB | 78 MB | | |
| current Snes9x `-Os` (zig 0.14.1) | 2.73 MB | 691 - 754 ms | 32 MiB | 80 MB | 824 KB | 0.56 ms |
| current Snes9x `-O2` (zig 0.14.1) | 2.90 MB | 724 - 807 ms | 32 MiB | 82 MB | | |
| *the NES app's core, for comparison* | *0.90 MB* | *65 - 68 ms* | *12 MiB* | | | |

- **Memory:** how far each core's memory reaches was measured with a build that grows, a 6 MB game and a save state (`bakeoff/memory.js`): 2002 24.9 MiB, 2005 21.1, 2005 plus 20.9, 2010 28.8, current 29.3. Each then got a few MiB more than that, fixed. With the memory fixed it never grew in any run, and the test suite checks that.
- **"The process holds"** is the measuring process, not the app: the app has the kit and its screens on top. The same core with a memory that grows instead held 146 MB after one game (current Snes9x), which is the NES project's lesson again.
- **All report 32040 samples a second** and about 534 a frame; 2005 and 2002 say 59.92 frames a second, 2010 and current 60.10.
- **Save states** are 0.4 to 0.8 MB and take a fraction of a millisecond to make. What writing one to the head unit's disk every 30 seconds costs is a question for the car; they shrink to a few percent with zlib on the test scenes.
- **snes9x2010's size** is mostly not emulator: its file list has PNG, WebP and DDS decoders for "HD packs".

### As native programs, for the cores that have no WebAssembly build

Milliseconds a frame on this PC, the same sources built for it (`node bakeoff/native-all.js`); these include hashing every picture.

| scene | 2005 | 2005 plus | 2010 | current | Supafaust, one thread | LakeSnes |
|---|---|---|---|---|---|---|
| Mode 7 text scroll | 0.15 | 0.25 | 0.32 | 0.35 | 0.51 | 1.48 |
| SuperFX polygons | 0.62 | 0.69 | 1.34 | 2.08 | *did not run it* | *no chips* |
| 512 x 448 picture | 0.35 | 0.44 | 1.00 | 0.61 | 0.79 | 2.98 |
| 512 x 448, mode 5 | 0.28 | 0.40 | 1.76 | 0.98 | 0.77 | 2.90 |
| a colour change every line | 0.18 | 0.25 | 0.31 | 0.32 | 0.50 | 1.71 |
| colour blending | 0.22 | 0.29 | 0.25 | 0.27 | 0.58 | 2.86 |
| a small Mode 7 game | 0.19 | 0.31 | 0.38 | 0.39 | 0.60 | 1.99 |
| music, a still picture | 0.13 | 0.19 | 0.20 | 0.22 | 0.33 | 0.91 |
| SA-1 at work | 0.26 | 0.37 | 0.35 | 0.44 | 1.35 | *no chips* |

WebAssembly under Node 8 costs the Snes9x cores 1.5 to 2.7 times their native speed. Supafaust's SuperFX figure is left out: on that test ROM it showed an empty picture.

## Checked against a native build

`node bakeoff/verify.js <core> -Os --frames 3000 --mash <games>`: the `.wasm` under Node 8 and the same sources as a native program, the same game, the same buttons (Start now and then, then directions and buttons from a fixed sequence), every frame's picture and every frame's sound compared. Eleven ROMs each: the nine scenes above and one CPU and one SPC700 test.

| core | result over 11 x 3000 frames |
|---|---|
| snes9x2010 | the same, picture and sound |
| current Snes9x | the same, picture and sound |
| snes9x2002 | the same, picture and sound |
| snes9x2005, and plus | the same, but for **one pixel of one picture**: on the frame MonsterFarmJump switches to 512 x 448, one pixel of the bottom row differs between any two builds of this core (`-Os`, `-O2`, native). The core leaves it undrawn on that frame. Every later frame and all the sound are the same |

## How right they are, as far as free tests tell

- **krom's 23 CPU and 7 SPC700 tests** (`bakeoff/cputests.js` compares where each core's test ends with where current Snes9x's does): snes9x2005, its plus variant and snes9x2010 end like it on 28 of 30. All three fail the same one, ADC: the flags of an addition in decimal mode, at the first decimal case, where current Snes9x passes every line. The other, MSC, is no verdict: current Snes9x stays on its WAI line, the three go on to the STP line, which the test itself says needs a reset. snes9x2002 differs on a third test (PHL).
- **snes9x2002 does not draw high resolution** (it gives 256 x 224 for a 512 x 448 picture) and shows this project's own test cartridge in the wrong colours (`test/run.js` fails on it). It is out.
- **The picture's size changes from frame to frame** in the three others: MonsterFarmJump and both high-resolution demos gave 256 x 224 and 512 x 448 in one run. The frontend reports each frame's size; the drawing has to follow.
- What the free tests cannot tell: how commercial games fare. By reputation the order is 2005, 2010, current, from least to most compatible, and 2005's own sound (Snes9x 1.43's) is its weakest part, which the plus variant replaces at 0.1 to 0.2 ms a frame here.

## The car

**To turn these numbers into the car's, one number from the car is needed, and the NES app already writes it.** Since its first version, and in 0.6.0 as the MGU Store installed it (`store/`'s `app.js`, line 327), the NES app logs every ten seconds a game runs

    game 60.0 fps, 0.85 ms a frame in the emulator

and at its start `nes: emulator compiled in ... ms`. Its log is a plain file on the head unit (`/var/opt/public/oap/oap_12244/data/clucraft_nes.log`). The same two things on this PC, with that app's `nes.wasm` under Node 8 (`node bakeoff/nes-baseline.js`):

| | this PC | the car |
|---|---|---|
| a frame of Snake or Pad Test | 0.26 ms | *not read yet* |
| compiling `nes.wasm` | 65 - 68 ms | *not read yet* |

The car's figure over 0.26 is how many times slower the head unit runs an emulator of this kind. Until it is read, a guess from the processors' class (an Apollo Lake Atom core against this PC's) is 6 to 10 times for a frame, and more for compiling, which uses every core a PC has.

With "well under half a frame" as the aim, 8 ms on the car is 0.8 ms on this PC at 10 times and 1.3 ms at 6 times:

| | on this PC | at 6 times | at 10 times |
|---|---|---|---|
| snes9x2005, without a chip | 0.16 - 0.52 ms | 1 - 3 ms | 2 - 5 ms |
| snes9x2005, SuperFX scene | 1.34 ms | 8 ms | 13 ms |
| snes9x2005 plus, without a chip | 0.26 - 0.66 ms | 2 - 4 ms | 3 - 7 ms |
| snes9x2010, 256 x 224 | 0.27 - 0.86 ms | 2 - 5 ms | 3 - 9 ms |
| snes9x2010, high resolution | 1.66 - 3.35 ms | 10 - 20 ms | 17 - 34 ms |
| snes9x2010, SuperFX scene | 2.54 ms | 15 ms | 25 ms |
| current Snes9x, 256 x 224 | 0.32 - 0.87 ms | 2 - 5 ms | 3 - 9 ms |
| current Snes9x, SuperFX scene | 3.67 ms | 22 ms | 37 ms |

A commercial game will sit above its row's test scenes.

## After the choice

The owner chose snes9x2005, with this project's own files under MIT (2026-11-20). The app carries both of its builds, `app/snes.wasm` and `app/snes-plus.wasm` (`core/build.js`, from the submodule `vendor/snes9x2005` at the commit measured here), and a setting picks. Two things were measured for the app after that, with those files under Node 8.17 on the same PC:

**A frame that is run and not drawn** (`node bakeoff/levers.js`). The frontend answers the core's question "draw this frame?" with no, and the core leaves its drawing out. Milliseconds a frame: every frame drawn / every second one / none.

| scene | `snes.wasm` | `snes-plus.wasm` |
|---|---|---|
| Mode 7 text scroll | 0.28 / 0.16 / 0.03 | 0.50 / 0.36 / 0.22 |
| SuperFX polygons | 1.34 / 1.35 / 1.28 | 1.52 / 1.50 / 1.42 |
| 512 x 448 picture | 0.56 / 0.32 / 0.07 | 0.70 / 0.45 / 0.19 |
| 512 x 448, mode 5 | 0.48 / 0.24 / 0.01 | 0.67 / 0.43 / 0.20 |
| a colour change every line | 0.32 / 0.20 / 0.08 | 0.48 / 0.35 / 0.23 |
| colour blending | 0.31 / 0.20 / 0.08 | 0.43 / 0.31 / 0.20 |
| a small Mode 7 game | 0.29 / 0.13 / 0.02 | 0.46 / 0.33 / 0.22 |
| music, a still picture | 0.16 / 0.14 / 0.10 | 0.27 / 0.22 / 0.19 |
| SA-1 at work | 0.37 / 0.30 / 0.22 | 0.51 / 0.43 / 0.36 |

So drawing is most of what a plain scene costs this core, and not drawing every second frame nearly halves it; a special chip's own work is not touched by it. blargg's sound chip costs about 0.2 ms a frame whatever is drawn. Shrinking a 512 x 448 picture to 256 x 224 in the frontend costs 0.06 ms.

**The sound, through the loader's real player** (`node tools/sound-try.js`): Pad Test's beeps, which the game starts every 60 frames at 1000 Hz, came out of `loader/snes-sound` at the device's 48000 samples a second 1.000 s apart, at 994 Hz with `snes.wasm` and 1002 Hz with `snes-plus.wasm`. Snes9x 1.43's sound chip emulation is a little flat; nobody has listened to either yet.

One of the free "games" used above, MonsterFarmJump, is a demo from krom's repository that shows another company's artwork. It was a scene to measure, kept in the git-ignored `roms/`, and is in no picture or file of this repository.

## Doing it again

    pip install --target .cache/py ziglang==0.13.0            (and ziglang==0.14.1 into .cache/py14 for current Snes9x)
    cd .cache/npm && npm install binaryen@119
    node bakeoff/build.js --fetch                             the cores, at the commits in cores.js
    node bakeoff/build.js snes9x2005 -O2 --grow               then: node bakeoff/memory.js snes9x2005
    node bakeoff/build.js snes9x2005 -Os                      and --native for the comparison
    node bakeoff/fix-headers.js roms/free/krom roms/free/fixed
    node bakeoff/run.js --builds snes9x2005-Os,... --state --out matrix <games>
    node bakeoff/table.js matrix
    node bakeoff/verify.js snes9x2005 -Os --frames 3000 --mash <games>

The free test ROMs are krom's (`PeterLemon/SNES` on GitHub) and Vitor Vilela's SnesSpeedTest 5.1 (an SA-1 cartridge). They are not in this repository, and no game is.
