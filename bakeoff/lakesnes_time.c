/*
 * lakesnes_time.c - how long LakeSnes (MIT; no libretro port, no special chips) takes for a frame on this
 * computer, as a native program: the one number the bake-off has for it. Built with its snes/ folder:
 *
 *   zig cc -O2 -I<LakeSnes>/snes -o lakesnes-time bakeoff/lakesnes_time.c <LakeSnes>/snes/*.c
 *   lakesnes-time <game.sfc> [frames]
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "snes.h"

int main(int argc, char **argv)
{
    FILE *f;
    long n;
    uint8_t *rom, *pixels;
    int16_t *samples;
    int frames = argc > 2 ? atoi(argv[2]) : 1500, i;
    uint32_t h = 2166136261u;
    Snes *snes;
    clock_t t0;
    if (argc < 2) { fprintf(stderr, "usage: %s <game.sfc> [frames]\n", argv[0]); return 2; }
    f = fopen(argv[1], "rb");
    if (!f) { fprintf(stderr, "cannot read %s\n", argv[1]); return 1; }
    fseek(f, 0, SEEK_END); n = ftell(f); fseek(f, 0, SEEK_SET);
    rom = malloc(n);
    if (fread(rom, 1, n, f) != (size_t)n) return 1;
    fclose(f);
    snes = snes_init();
    if (!snes_loadRom(snes, rom, (int)n)) { printf("refused\n"); return 1; }
    pixels = calloc(512 * 480, 4);
    samples = calloc(2048, 4);
    t0 = clock();
    for (i = 0; i < frames; i++) {
        snes_runFrame(snes);
        snes_setPixels(snes, pixels);
        snes_setSamples(snes, samples, 534);
    }
    printf("native ms/frame %.3f", (double)(clock() - t0) * 1000.0 / CLOCKS_PER_SEC / frames);
    for (i = 0; i < 512 * 480; i++) h = (h ^ ((uint32_t *)pixels)[i]) * 16777619u;
    printf("  (last picture %08x)\n", h);
    return 0;
}
