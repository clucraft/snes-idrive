/*
 * native_main.c - the same core and the same frontend (core/mgu_libretro.c) as a program for this computer:
 * what the .wasm's pictures and sound are checked against (bakeoff/verify.js).
 *
 *   <core>-native <game.sfc> <frames> [pads.bin] [key=value]...
 *
 * pads.bin: the buttons held in each frame, 16 bits each (bakeoff/bench.js --pads-out). Prints, every 300
 * frames and at the end, the lines bench.js --hash prints: frame, picture size, a hash over every picture so
 * far, a hash over all the sound so far. And at the end how long a frame took here, for comparison.
 * With MGU_HASHES=<file> it also writes every frame's own two hashes there (32 bits each), as bench.js
 * --hashes-out does: verify.js counts with them how many frames differ when the lines do.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

int mgu_init(void);
int mgu_set_var(const char *key, const char *val);
void *mgu_alloc(unsigned n);
int mgu_load(void *data, unsigned n);
void mgu_set_pad(unsigned port, unsigned mask);
int mgu_run(void);
const void *mgu_frame_ptr(void);
unsigned mgu_frame_w(void);
unsigned mgu_frame_h(void);
const void *mgu_audio_ptr(void);
unsigned mgu_audio_frames(void);
unsigned mgu_fps_milli(void);
unsigned mgu_sample_rate(void);
unsigned mgu_state_size(void);

static int verbose;
void js_log(int level, const char *text, int len) { if (verbose) fprintf(stderr, "core[%d]: %.*s\n", level, len, text); }

static uint8_t *slurp(const char *name, long *n)
{
    FILE *f = fopen(name, "rb");
    uint8_t *b;
    if (!f) return NULL;
    fseek(f, 0, SEEK_END); *n = ftell(f); fseek(f, 0, SEEK_SET);
    b = (uint8_t *)malloc(*n ? *n : 1);
    if (fread(b, 1, *n, f) != (size_t)*n) { fclose(f); free(b); return NULL; }
    fclose(f);
    return b;
}

int main(int argc, char **argv)
{
    long romn = 0, padn = 0, skip;
    uint8_t *rom, *padb = NULL;
    void *p;
    int frames, f, i;
    uint32_t hv = 2166136261u, ha = 2166136261u, pv, pa;
    unsigned w = 0, h = 0;
    clock_t t0;
    FILE *each = getenv("MGU_HASHES") ? fopen(getenv("MGU_HASHES"), "wb") : NULL;   /* every frame's two hashes */
    if (argc < 3) { fprintf(stderr, "usage: %s <game.sfc> <frames> [pads.bin] [key=value]...\n", argv[0]); return 2; }
    if (getenv("MGU_VERBOSE")) verbose = 1;
    rom = slurp(argv[1], &romn);
    if (!rom) { fprintf(stderr, "cannot read %s\n", argv[1]); return 1; }
    frames = atoi(argv[2]);
    mgu_init();
    for (i = 3; i < argc; i++) {
        char *eq = strchr(argv[i], '=');
        if (eq) { *eq = 0; mgu_set_var(argv[i], eq + 1); }
        else if (!padb) padb = slurp(argv[i], &padn);
    }
    skip = (romn & 0x3ff) == 512 ? 512 : 0;                 /* a copier's header, as app/snes-core.js drops it */
    p = mgu_alloc((unsigned)(romn - skip));
    memcpy(p, rom + skip, romn - skip);
    if (!mgu_load(p, (unsigned)(romn - skip))) { printf("error: the core did not take the game\n"); return 1; }
    printf("fps %u sampleRate %u stateBytes %u\n", mgu_fps_milli(), mgu_sample_rate(), mgu_state_size());
    t0 = clock();
    for (f = 0; f < frames; f++) {
        unsigned n, k, an;
        const uint32_t *px;
        const uint16_t *au;
        mgu_set_pad(0, padb && (long)(f * 2 + 1) < padn ? (unsigned)(padb[f * 2] | (padb[f * 2 + 1] << 8)) : 0);
        mgu_run();
        /* this frame's picture and its sound, each hashed by itself, and those chained (as bench.js --hash) */
        pv = 2166136261u; pa = 2166136261u;
        px = (const uint32_t *)mgu_frame_ptr(); w = mgu_frame_w(); h = mgu_frame_h();
        if (px && w && h) {
            n = w * h;
            for (k = 0; k < n; k++) pv = (pv ^ px[k]) * 16777619u;
            pv = (pv ^ ((w << 16) | h)) * 16777619u;
        }
        au = (const uint16_t *)mgu_audio_ptr(); an = mgu_audio_frames();
        if (au && an) {
            for (k = 0; k < an * 2; k++) pa = (pa ^ au[k]) * 16777619u;
            pa = (pa ^ an) * 16777619u;
        }
        hv = (hv ^ pv) * 16777619u; ha = (ha ^ pa) * 16777619u;
        if (each) { fwrite(&pv, 4, 1, each); fwrite(&pa, 4, 1, each); }
        if ((f + 1) % 300 == 0 || f + 1 == frames) printf("%d %ux%u %08x %08x\n", f + 1, w, h, hv, ha);
    }
    if (each) fclose(each);
    printf("native ms/frame %.3f\n", (double)(clock() - t0) * 1000.0 / CLOCKS_PER_SEC / (frames ? frames : 1));
    return 0;
}
