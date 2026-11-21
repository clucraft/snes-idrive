# The emulator core

`app/snes.wasm` and `app/snes-plus.wasm` are [libretro's snes9x2005](https://github.com/libretro/snes9x2005) (Snes9x 1.43, by way of the DS ports NDSSFC, BAGSFC and CATSFC), commit `a79dfe9`, **unchanged**, as the submodule `vendor/snes9x2005`, compiled to WebAssembly together with one file from here.

| | |
|---|---|
| `snes.wasm` | the core with its own sound chip emulation, Snes9x 1.43's |
| `snes-plus.wasm` | the same with blargg's (the core's `USE_BLARGG_APU`): truer sound, 0.1 to 0.2 ms more a frame on a PC |

The app's setting *Sound chip* picks between them. Why this core and not another is [`bakeoff/README.md`](../bakeoff/README.md).

**Its licence is not this repository's.** Snes9x may be used, copied, changed and passed on for non-commercial purposes only. The core's own licence file is `LICENSE.snes9x2005` at the repository's top (a copy of the submodule's `copyright`), and [`NOTICE`](../NOTICE) says what that means for the app.

## `mgu_libretro.c`

A libretro frontend of some 320 lines: the NES project's, with two switches more. The core runs as WebAssembly inside the app's Node.js process; JavaScript (`app/snes-core.js`) hands it the game's bytes and the pad's buttons, runs it one frame at a time and takes each picture as RGBA bytes, as the kit's GPU renderer wants them. It also carries:

- the core options (`mgu_set_var`)
- save states and battery memory, through buffers
- the frame's sound samples and the rate the core makes them at
- `mgu_set_draw(0)`: the frames from then on are run and heard, and not drawn. A core that asks its frontend each frame whether to draw (`RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE`), as this one does, then leaves its drawing out, which is most of what a frame costs
- `mgu_set_shrink(1)`: a picture over 256 wide or 240 high (an SNES's high-resolution modes) is halved that way by averaging

The core needs no files: the C library's file calls are answered "not there" in `snes-core.js`. `libretro.h` here is libretro's API header (MIT), newer than the core's own copy; the frontend is compiled against it. Nothing in the frontend is specific to this core.

## `build.js`

```bash
npm run build:core
```

It needs **zig 0.13** (`pip install ziglang==0.13.0`) and **binaryen 119** (`npm install binaryen@119`, or `WASM_OPT=/path/to/wasm-opt`), the versions the kit builds Doom with. The committed files are built from exactly this source, and two builds on one computer give the same bytes (`node core/build.js --check` builds again and compares):

| | bytes | SHA-256 |
|---|---|---|
| `snes.wasm` | 605864 | `6c71e2c1...bfec95` |
| `snes-plus.wasm` | 537104 | `bd50c760...6a72e2` |

As for the kit's Doom and the NES app's core, it builds for wasm32-wasi with the first version of WebAssembly only (the head unit's Node 8), and binaryen lowers sign extension and splits 64-bit arguments. Besides:

- **24 MiB of memory from the start, a 2 MiB stack.** Node 8 grows a WebAssembly memory by copying it, and the copies count against the app's memory limit. The core reaches 21 MiB with a 6 MB game and a save state; the rest is room for what a special chip's game may still ask for. The tests fail if the memory ever grows.
- **`-Os`.** For this core `-O2` is no faster under Node 8, and bigger.
- The file list is the core's own `Makefile.common` with `LOAD_FROM_MEMORY=1`, as its Makefile has it.

## What it was checked against

All on a PC (2026-11-20), none of it on a head unit:

- **A native build:** the same sources built for x86-64 and the `.wasm` under Node 8.17 give the same picture and the same sound, frame for frame, over 3000 frames with buttons pressed, on eight ROMs, *Pad Test* among them (`node bakeoff/verify.js snes9x2005 -Os --frames 3000 --mash ...`, and the same for `snes9x2005_plus`). The one difference ever seen is one pixel of one frame, between any two builds of this core, on the frame a game switched to 512 x 448: the core leaves it undrawn.
- **The app's files against those:** `app/snes.wasm` and `app/snes-plus.wasm` draw what the bake-off's builds of the same source draw (`bakeoff/diff.js`, 2000 frames, three ROMs each).
- **krom's CPU and SPC700 tests:** 28 of 30 end as on current Snes9x. It fails one, the flags of an addition in decimal mode.
- **Memory:** 24 MiB for the core. What the app's whole process holds with a game running has not been measured for this app; the measuring process alone held 57 MB.
- **Speed:** [`bakeoff/README.md`](../bakeoff/README.md). 0.16 to 0.52 ms a frame on this PC for scenes without a special chip, 1.3 ms with a SuperFX demo. A frame that is run and not drawn costs 0.01 to 0.1 ms of that on the plain scenes, and nearly all of it on the SuperFX one.
