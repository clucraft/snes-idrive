'use strict';
/**
 * cores.js - the SNES cores of the bake-off: where each comes from, and what of it is compiled.
 *
 * The sources are fetched into .cache/cores/<dir> at the commit named here (bakeoff/build.js --fetch).
 * The lists follow each core's own Makefile.common; what is left out says so.
 *
 *   mem    the WebAssembly memory, all of it from the start (measured: bakeoff/README.md)
 *   stack  the C stack inside it
 */
const COMM = (dir, list) => list.map((f) => dir + '/' + f);

/* libretro-common's file layer, which the cores' libretro.c reaches for (the C library answers "not there") */
const VFS = ['compat/compat_posix_string.c', 'compat/compat_strcasestr.c', 'compat/compat_snprintf.c', 'compat/compat_strl.c',
    'compat/fopen_utf8.c', 'encodings/encoding_utf.c', 'file/file_path.c', 'file/file_path_io.c', 'streams/file_stream.c',
    'streams/file_stream_transforms.c', 'string/stdstring.c', 'time/rtime.c', 'vfs/vfs_implementation.c'];

const S2005 = ['c4.c', 'c4emu.c', 'cheats2.c', 'cheats.c', 'clip.c', 'cpu.c', 'cpuexec.c', 'cpuops.c', 'data.c', 'dma.c', 'dsp1.c',
    'fxemu.c', 'fxinst.c', 'gfx.c', 'getset.c', 'globals.c', 'memmap.c', 'obc1.c', 'ppu.c', 'sa1.c', 'sa1cpu.c', 'sdd1.c',
    'sdd1emu.c', 'seta010.c', 'seta011.c', 'seta018.c', 'seta.c', 'spc7110.c', 'spc7110dec.c', 'srtc.c', 'tile.c'];

const cores = {
    /* Snes9x 1.43 by way of the DS ports (CATSFC). C. Its own sound code (Snes9x 1.43's). */
    snes9x2005: {
        title: 'snes9x2005', what: 'Snes9x 1.43, C', repo: 'libretro/snes9x2005', commit: 'a79dfe9047e7fec58808aefe48ad2bf499c7af11',
        dir: 'snes9x2005',
        srcs: COMM('source', S2005.concat(['apu.c', 'soundux.c', 'spc700.c'])).concat(['libretro.c']),
        inc: ['source', '.', 'libretro-common/include'],
        defs: ['-DLOAD_FROM_MEMORY', '-DLAGFIX', '-DNDEBUG', '-fno-strict-overflow'],
        prefix: 'snes9x_2005',
    },
    /* the same with blargg's S-DSP in place of Snes9x 1.43's sound: the "plus" variant */
    snes9x2005_plus: {
        title: 'snes9x2005 plus', what: 'Snes9x 1.43 with blargg\'s sound, C', repo: 'libretro/snes9x2005', commit: 'a79dfe9047e7fec58808aefe48ad2bf499c7af11',
        dir: 'snes9x2005',
        srcs: COMM('source', S2005.concat(['apu_blargg.c'])).concat(['libretro.c']),
        inc: ['source', '.', 'libretro-common/include'],
        defs: ['-DLOAD_FROM_MEMORY', '-DLAGFIX', '-DNDEBUG', '-DUSE_BLARGG_APU', '-fno-strict-overflow'],
        prefix: 'snes9x_2005',
    },
    /* Snes9x 1.52 (once "snes9x-next"). C. Built without threads, HD packs' image decoders left in as the Makefile has them. */
    snes9x2010: {
        title: 'snes9x2010', what: 'Snes9x 1.52, C', repo: 'libretro/snes9x2010', commit: '82904a95e9bab2c3e63395e4b9ece8fdca8b785d',
        dir: 'snes9x2010',
        srcs: COMM('src', ['apu.c', 'hdpack.c', 'bsx.c', 'bsflash.c', 'c4emu.c', 'cheats.c', 'controls.c', 'cpu.c', 'cpuexec.c', 'dsp.c', 'fxemu.c',
            'globals.c', 'memmap.c', 'obc1.c', 'msu1.c', 'msu1_pack.c', 'ppu.c', 'sa1.c', 'sdd1.c', 'seta.c', 'snapshot.c', 'spc7110.c',
            'srtc.c', 'tile.c', 'hwregisters.c'])
            .concat(['filter/snes_ntsc.c', 'libretro/libretro.c'])
            .concat(COMM('libretro/libretro-common', ['streams/memory_stream.c',
                'formats/png/rpng.c', 'formats/png/rpng_encode.c', 'formats/png/rpng_apng.c', 'file/rpng_file.c', 'features/features_cpu.c',
                'formats/image_transfer.c', 'formats/webp/rwebp.c', 'formats/vp8/rvp8.c', 'formats/dds/rdds.c', 'streams/trans_stream.c',
                'streams/trans_stream_pipe.c', 'streams/trans_stream_deflate.c', 'encodings/encoding_deflate.c', 'encodings/encoding_crc32.c',
                'streams/interface_stream.c', 'streams/rzip_stream.c', 'memmap/memalign.c', 'string/rstrtod.c', 'vfs/vfs_hybrid.c',
                'file/retro_dirent.c'].concat(VFS))),
        inc: ['libretro', 'src', 'libretro/libretro-common/include'],
        defs: ['-DHAVE_RPNG', '-DHAVE_RWEBP', '-DHAVE_RDDS', '-DINLINE=inline', '-DNDEBUG', '-fno-strict-aliasing'],
        nativeDefs: ['-mevex512'],                    // (libretro-common's CRC-32 has an AVX-512 path zig 0.13's clang wants this for)
        prefix: 'snes9x_2010',
    },
    /* current Snes9x as libretro keeps it: C++ and C. Zip files and the NTSC filter are in its list and stay in. */
    snes9x: {
        title: 'snes9x', what: 'current Snes9x, C++', repo: 'libretro/snes9x', commit: '204ea1c0b851f960cbf223075eb1c25641cb483c',
        dir: 'snes9x', cxx: true,
        srcs: ['c4emu.c', 'msu1.c', 'zipfile.c', 'srtc.c', 'obc1.c', 'bsflash.c', 'tile.c', 'bsx.c', 'spc7110.c', 'fxemu.c', 'sdd1.c', 'seta.c',
            'sa1hw.c', 'dsp.c', 'filter/snes_ntsc.c',
            'apu/apu.cpp', 'apu/bapu/dsp/sdsp.cpp', 'apu/bapu/smp/smp.cpp', 'apu/bapu/smp/smp_state.cpp', 'cheats2.cpp', 'clip.cpp',
            'controls.cpp', 'cpu.cpp', 'cpuexec.cpp', 'cpuops.cpp', 'crosshairs.cpp', 'dma.cpp', 'gfx.cpp', 'globals.cpp', 'loadzip.cpp',
            'memmap.cpp', 'ppu.cpp', 'sa1.cpp', 'sa1cpu.cpp', 'snapshot.cpp', 'sha256.cpp', 'bml.cpp', 'fscompat.cpp', 'libretro/libretro.cpp']
            .concat(COMM('libretro/libretro-common', ['encodings/encoding_crc32.c', 'encodings/encoding_deflate.c', 'features/features_cpu.c',
                'string/rstrtod.c', 'vfs/vfs_hybrid.c', 'file/retro_dirent.c'].concat(VFS))),
        inc: ['libretro', 'libretro/libretro-common/include', '.', 'apu', 'apu/bapu'],
        defs: ['-DNDEBUG', '-DSKIP_STDIO_REDEFINES', '-fno-strict-aliasing'], nativeDefs: ['-mevex512'],
        prefix: 'snes9x',
    },
    /* Snes9x 1.39 (PocketSNES). C. Not in the brief's table: here as the lightest thing there is. */
    snes9x2002: {
        title: 'snes9x2002', what: 'Snes9x 1.39, C', repo: 'libretro/snes9x2002', commit: '6ffbf9ef4f0063e1f1b78a40d10c50fc52f2524c',
        dir: 'snes9x2002',
        srcs: COMM('src', ['apu.c', 'apuaux.c', 'c4.c', 'c4emu.c', 'cheats.c', 'cheats2.c', 'clip.c', 'data.c', 'dsp1.c', 'fxemu.c', 'fxinst.c',
            'globals.c', 'dma.c', 'memmap.c', 'cpu.c', 'cpuexec.c', 'cpuops.c', 'sa1.c', 'sa1cpu.c', 'sdd1.c', 'sdd1emu.c', 'snapshot.c',
            'soundux.c', 'spc700.c', 'srtc.c', 'ppu_.c', 'gfx.c', 'tile.c'])
            .concat(['libretro/libretro.c', 'libretro/libretro-common/streams/memory_stream.c']),
        inc: ['.', 'libretro', 'libretro/libretro-common/include', 'src'],
        defs: ['-D__OLD_RASTER_FX__', '-DHAVE_STRINGS_H', '-DHAVE_STDINT_H', '-DHAVE_INTTYPES_H', '-DUSE_SA1', '-DLAGFIX', '-DNDEBUG=1',
            '-fomit-frame-pointer'],
        prefix: 'snes9x2002',
    },
    /* Mednafen's snes_faust. C++ with exceptions and threads: see bakeoff/README.md for what it takes. */
    supafaust: {
        title: 'supafaust', what: 'Mednafen snes_faust, C++', repo: 'libretro/supafaust', commit: '642d1d1b6684aa7e306a02a89885f3f5456a5157',
        dir: 'supafaust', cxx: true,
        srcs: COMM('mednafen', ['mednafen.cpp', 'endian.cpp', 'git.cpp', 'error.cpp', 'settings.cpp', 'mempatcher.cpp', 'state.cpp',
            'string/string.cpp', 'Stream.cpp', 'FileStream.cpp', 'VirtualFS.cpp', 'NativeVFS.cpp', 'ExtMemStream.cpp', 'MemoryStream.cpp',
            'sound/DSPUtility.cpp', 'sound/OwlResampler.cpp', 'video/convert.cpp', 'video/Deinterlacer_Blend.cpp',
            'video/Deinterlacer_Simple.cpp', 'video/Deinterlacer.cpp', 'video/surface.cpp', 'cheat_formats/snes.cpp', 'hash/sha1.cpp',
            'hash/sha256.cpp', 'MTStreamReader.cpp',
            'snes_faust/apu.cpp', 'snes_faust/cpu.cpp', 'snes_faust/ppu.cpp', 'snes_faust/ppu_mt.cpp', 'snes_faust/ppu_mtrender.cpp',
            'snes_faust/cart.cpp', 'snes_faust/input.cpp', 'snes_faust/snes.cpp', 'snes_faust/cart/dsp1.cpp', 'snes_faust/cart/dsp2.cpp',
            'snes_faust/cart/sdd1.cpp', 'snes_faust/cart/cx4.cpp', 'snes_faust/cart/superfx.cpp', 'snes_faust/cart/sa1.cpp',
            'snes_faust/cart/sa1cpu.cpp', 'snes_faust/msu1.cpp', 'snes_faust/ppu_st.cpp']).concat(['libretro.cpp']),
        threads: { win: 'mednafen/mthreading/MThreading_Win32.cpp', posix: 'mednafen/mthreading/MThreading_POSIX.cpp' },
        inc: ['.', 'mednafen', 'mednafen/include'],
        defs: ['-DNDEBUG', '-DLSB_FIRST', '-DPSS_STYLE=1', '-D_GNU_SOURCE=1', '-DGIT_VERSION=""', '-fsigned-char', '-fwrapv'], cxxflags: ['-std=c++11'],
        nativeDefs: process.platform === 'win32' && !/linux/.test(process.env.NATIVE_TARGET || '') ? ['-include', 'process.h'] : [],
        prefix: 'supafaust',
    },
};

/* The memory each gets from the start: what bakeoff/memory.js saw it reach with a 6 MB game and a save state
   (2002: 24.9 MiB, 2005: 21.1, 2005 plus: 20.9, 2010: 28.8), and a few MiB over for what a special chip's game
   may still ask for. */
cores.snes9x2002.mem = '0x1C00000';
cores.snes9x2005.mem = '0x1800000';
cores.snes9x2005_plus.mem = '0x1800000';
cores.snes9x2010.mem = '0x2000000';
cores.snes9x.mem = '0x2000000';                       // (29.3 MiB reached)

/* Supafaust as libretro has it always draws on a second thread: retro_load_game sets the renderer to "mt" after
   reading the option. This variant, for measuring only, takes that one line out, so the option "st" counts. */
cores.supafaust_st = Object.assign({}, cores.supafaust, {
    title: 'supafaust, one thread', what: 'Mednafen snes_faust with its single-thread renderer (one line changed)',
    patch: {
        'libretro.cpp': [['  MDFNI_SetSetting("snes_faust.renderer", "mt");', '  /* (measuring variant: the option decides) */']],
        // and says what it throws (its errors carry no text)
        'mednafen/error.cpp': [[' errno_code = errno_code_new;\n}', ' errno_code = errno_code_new;\n { va_list ap; va_start(ap, format); fprintf(stderr, "MDFN_Error(%d): ", errno_code_new); vfprintf(stderr, format ? format : "", ap); fprintf(stderr, "\\n"); va_end(ap); }\n}']],
    },
});

module.exports = cores;
