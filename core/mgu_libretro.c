/*
 * mgu_libretro.c - a small libretro frontend for a core that runs as WebAssembly inside an iDrive
 * app (app/): the core's callbacks on one side, a handful of exports for JavaScript
 * (app/snes-core.js) on the other. Nothing in it is specific to one core: it is the NES project's
 * frontend (clucraft/nes-idrive, core/mgu_libretro.c), and any libretro core built with it gets the
 * same exports.
 *
 *   mgu_init()                       once
 *   mgu_set_var(key, value)          a core option (the core's default when not set)
 *   p = mgu_alloc(n); copy the ROM to p; mgu_load(p, n) -> 1 loaded (the ROM stays the core's)
 *   mgu_set_pad(port, mask)          the joypad's buttons, bit = RETRO_DEVICE_ID_JOYPAD_*
 *   mgu_run() -> 1 a new picture     one video frame
 *   mgu_set_draw(0 | 1)              0: the frames from now are run and heard, and not drawn (a core that asks
 *                                    RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE then skips its drawing)
 *   mgu_set_shrink(0 | 1)            1: a picture over 256 wide is halved in width, one over 240 high in height,
 *                                    by averaging (an SNES's high-resolution modes, as the console's own size)
 *   mgu_frame_ptr / _w / _h          the picture: RGBA bytes, opaque, rows top-down, cropped
 *   mgu_audio_ptr / _frames          the frame's sound: int16 stereo, mgu_sample_rate() samples a second
 *   mgu_state_size / _save / _load   a save state in a buffer from mgu_alloc
 *   mgu_sram_ptr / _size             the cartridge's battery memory
 *
 * MIT (LICENSE at the repository's top). The core it is linked with keeps its own licence: NOTICE.
 */
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "libretro.h"

#define IMPORT(name) __attribute__((import_module("env"), import_name(#name)))
#define EXPORT(name) __attribute__((export_name(#name)))

/* a line of the core's log: level (RETRO_LOG_*), text, length */
IMPORT(js_log) void js_log(int level, const char *text, int len);

/* ---------------- core options ---------------- */
#define MAX_VARS 64
#define VAR_LEN 64
static struct { char key[VAR_LEN]; char val[VAR_LEN]; } vars[MAX_VARS];
static int nvars;
static bool vars_dirty;

EXPORT(mgu_set_var) int mgu_set_var(const char *key, const char *val)
{
    int i;
    if (!key || !val || strlen(key) >= VAR_LEN || strlen(val) >= VAR_LEN) return 0;
    for (i = 0; i < nvars; i++) if (!strcmp(vars[i].key, key)) break;
    if (i == nvars) {
        if (nvars == MAX_VARS) return 0;
        strcpy(vars[nvars++].key, key);
    } else if (!strcmp(vars[i].val, val)) return 1;
    strcpy(vars[i].val, val);
    vars_dirty = true;
    return 1;
}

/* ---------------- video ---------------- */
static enum retro_pixel_format pixfmt = RETRO_PIXEL_FORMAT_0RGB1555;
static uint32_t *out;                 /* RGBA bytes (little endian words 0xAABBGGRR) */
static unsigned out_cap, out_w, out_h;
static unsigned crop_l, crop_t, crop_r, crop_b;
static int have_frame;
static int draw = 1, shrink;

/* the mean of two RGBA pixels, channel by channel (alpha stays opaque) */
static inline uint32_t mean2(uint32_t a, uint32_t b) { return (a & b) + (((a ^ b) & 0xfefefefeu) >> 1); }

/* out, ow x oh, made half as wide (wide) and half as high (high), in place */
static void halve(unsigned ow, unsigned oh, int wide, int high)
{
    unsigned x, y, nw = wide ? ow / 2 : ow, nh = high ? oh / 2 : oh;
    for (y = 0; y < nh; y++) {
        const uint32_t *a = out + (size_t)(high ? y * 2 : y) * ow, *b = high ? a + ow : a;
        uint32_t *d = out + (size_t)y * nw;
        if (wide) for (x = 0; x < nw; x++) d[x] = high ? mean2(mean2(a[x * 2], a[x * 2 + 1]), mean2(b[x * 2], b[x * 2 + 1])) : mean2(a[x * 2], a[x * 2 + 1]);
        else for (x = 0; x < nw; x++) d[x] = mean2(a[x], b[x]);
    }
    out_w = nw; out_h = nh;
}

static void video_cb(const void *data, unsigned w, unsigned h, size_t pitch)
{
    unsigned l = crop_l, t = crop_t, r = crop_r, b = crop_b, ow, oh, x, y;
    uint32_t *d;
    if (!data || !w || !h) return;                    /* the same picture again */
    if (l + r >= w) l = r = 0;
    if (t + b >= h) t = b = 0;
    ow = w - l - r; oh = h - t - b;
    if (ow * oh > out_cap) {
        free(out);
        out_cap = ow * oh;
        out = (uint32_t *)malloc((size_t)out_cap * 4);
        if (!out) { out_cap = 0; return; }
    }
    d = out;
    for (y = 0; y < oh; y++) {
        const uint8_t *row = (const uint8_t *)data + (size_t)(y + t) * pitch;
        if (pixfmt == RETRO_PIXEL_FORMAT_XRGB8888) {
            const uint32_t *s = (const uint32_t *)row + l;
            for (x = 0; x < ow; x++) {
                uint32_t v = s[x];
                *d++ = 0xff000000u | ((v & 0xff) << 16) | (v & 0xff00) | ((v >> 16) & 0xff);
            }
        } else if (pixfmt == RETRO_PIXEL_FORMAT_RGB565) {
            const uint16_t *s = (const uint16_t *)row + l;
            for (x = 0; x < ow; x++) {
                uint32_t v = s[x], r5 = v >> 11, g6 = (v >> 5) & 63, b5 = v & 31;
                *d++ = 0xff000000u | (((b5 << 3) | (b5 >> 2)) << 16) | (((g6 << 2) | (g6 >> 4)) << 8) | ((r5 << 3) | (r5 >> 2));
            }
        } else {
            const uint16_t *s = (const uint16_t *)row + l;
            for (x = 0; x < ow; x++) {
                uint32_t v = s[x], r5 = (v >> 10) & 31, g5 = (v >> 5) & 31, b5 = v & 31;
                *d++ = 0xff000000u | (((b5 << 3) | (b5 >> 2)) << 16) | (((g5 << 3) | (g5 >> 2)) << 8) | ((r5 << 3) | (r5 >> 2));
            }
        }
    }
    out_w = ow; out_h = oh;
    if (shrink && (ow > 256 || oh > 240)) halve(ow, oh, ow > 256, oh > 240);
    have_frame = 1;
}

/* ---------------- audio (kept for the frame) ---------------- */
#define AUDIO_MAX 4096
static int16_t audio[AUDIO_MAX * 2];
static unsigned audio_n;

static size_t audio_batch_cb(const int16_t *data, size_t frames)
{
    size_t n = frames;
    if (n > AUDIO_MAX - audio_n) n = AUDIO_MAX - audio_n;
    memcpy(audio + audio_n * 2, data, n * 4);
    audio_n += (unsigned)n;
    return frames;
}
static void audio_sample_cb(int16_t l, int16_t r)
{
    if (audio_n < AUDIO_MAX) { audio[audio_n * 2] = l; audio[audio_n * 2 + 1] = r; audio_n++; }
}

/* ---------------- input ---------------- */
#define PORTS 4
static uint16_t pads[PORTS];

static void input_poll_cb(void) { }
static int16_t input_state_cb(unsigned port, unsigned device, unsigned index, unsigned id)
{
    if (port >= PORTS || (device & RETRO_DEVICE_MASK) != RETRO_DEVICE_JOYPAD) return 0;
    if (id == RETRO_DEVICE_ID_JOYPAD_MASK) return (int16_t)pads[port];
    return id < 16 ? (pads[port] >> id) & 1 : 0;
}

/* ---------------- environment ---------------- */
/* the game being loaded: its bytes, for cores that otherwise open the ROM's path themselves */
static struct retro_game_info_ext game_ext;
static bool loading;

static void log_printf(enum retro_log_level level, const char *fmt, ...)
{
    char buf[512];
    va_list ap;
    int n;
    va_start(ap, fmt);
    n = vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    if (n < 0) return;
    if (n >= (int)sizeof buf) n = sizeof buf - 1;
    js_log((int)level, buf, n);
}

static bool environ_cb(unsigned cmd, void *data)
{
    switch (cmd) {
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: {
        enum retro_pixel_format f = *(const enum retro_pixel_format *)data;
        if (f != RETRO_PIXEL_FORMAT_XRGB8888 && f != RETRO_PIXEL_FORMAT_RGB565 && f != RETRO_PIXEL_FORMAT_0RGB1555) return false;
        pixfmt = f;
        return true;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE: {
        struct retro_variable *v = (struct retro_variable *)data;
        int i;
        if (!v || !v->key) return false;
        for (i = 0; i < nvars; i++) if (!strcmp(vars[i].key, v->key)) { v->value = vars[i].val; return true; }
        v->value = NULL;
        return false;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
        *(bool *)data = vars_dirty;
        vars_dirty = false;
        return true;
    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
        ((struct retro_log_callback *)data)->log = log_printf;
        return true;
    case RETRO_ENVIRONMENT_GET_GAME_INFO_EXT:
        if (!loading) return false;
        *(const struct retro_game_info_ext **)data = &game_ext;
        return true;
    case RETRO_ENVIRONMENT_GET_CAN_DUPE:
        *(bool *)data = true;
        return true;
    case RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE:        /* bit 0: draw the frame, bit 1: make its sound */
        *(int *)data = (draw ? 1 : 0) | 2;
        return true;
    case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
    case RETRO_ENVIRONMENT_SET_GEOMETRY:
    case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
    case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
    case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
    case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
    case RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS:
        return true;
    default:                                          /* no directories, no VFS, no messages: the core's own ways */
        return false;
    }
}

/* ---------------- the app's side ---------------- */
static bool inited, loaded;
static void *rom;
static struct retro_system_av_info av;

EXPORT(mgu_alloc) void *mgu_alloc(unsigned n) { return malloc(n ? n : 1); }
EXPORT(mgu_free) void mgu_free(void *p) { free(p); }

EXPORT(mgu_init) int mgu_init(void)
{
    if (inited) return 1;
    retro_set_environment(environ_cb);
    retro_set_video_refresh(video_cb);
    retro_set_audio_sample(audio_sample_cb);
    retro_set_audio_sample_batch(audio_batch_cb);
    retro_set_input_poll(input_poll_cb);
    retro_set_input_state(input_state_cb);
    retro_init();
    inited = true;
    return 1;
}

EXPORT(mgu_unload) void mgu_unload(void)
{
    if (loaded) { retro_unload_game(); loaded = false; }
    free(rom); rom = NULL;
    have_frame = 0; out_w = out_h = 0; audio_n = 0;
    memset(pads, 0, sizeof pads);
}

/* data: from mgu_alloc, n bytes of ROM; the core keeps it until mgu_unload (or the next mgu_load) */
EXPORT(mgu_load) int mgu_load(void *data, unsigned n)
{
    struct retro_game_info info;
    int port;
    if (!inited) mgu_init();
    mgu_unload();
    rom = data;
    memset(&info, 0, sizeof info);
    info.path = "game.sfc";
    info.data = data;
    info.size = n;
    memset(&game_ext, 0, sizeof game_ext);
    game_ext.full_path = info.path;
    game_ext.dir = "";
    game_ext.name = "game";
    game_ext.ext = "sfc";
    game_ext.data = data;
    game_ext.size = n;
    game_ext.persistent_data = true;                 /* ours until mgu_unload */
    loading = true;
    loaded = retro_load_game(&info);
    loading = false;
    if (!loaded) { free(rom); rom = NULL; return 0; }
    for (port = 0; port < 2; port++) retro_set_controller_port_device(port, RETRO_DEVICE_JOYPAD);
    memset(&av, 0, sizeof av);
    retro_get_system_av_info(&av);
    return 1;
}

EXPORT(mgu_run) int mgu_run(void)
{
    if (!loaded) return 0;
    have_frame = 0;
    audio_n = 0;
    retro_run();
    return have_frame;
}

EXPORT(mgu_reset) void mgu_reset(void) { if (loaded) retro_reset(); }
EXPORT(mgu_set_pad) void mgu_set_pad(unsigned port, unsigned mask) { if (port < PORTS) pads[port] = (uint16_t)mask; }
EXPORT(mgu_set_crop) void mgu_set_crop(unsigned l, unsigned t, unsigned r, unsigned b) { crop_l = l; crop_t = t; crop_r = r; crop_b = b; }
EXPORT(mgu_set_draw) void mgu_set_draw(int on) { draw = on != 0; }
EXPORT(mgu_set_shrink) void mgu_set_shrink(int on) { shrink = on != 0; }

EXPORT(mgu_frame_ptr) const void *mgu_frame_ptr(void) { return out; }
EXPORT(mgu_frame_w) unsigned mgu_frame_w(void) { return out_w; }
EXPORT(mgu_frame_h) unsigned mgu_frame_h(void) { return out_h; }

EXPORT(mgu_audio_ptr) const void *mgu_audio_ptr(void) { return audio; }
EXPORT(mgu_audio_frames) unsigned mgu_audio_frames(void) { return audio_n; }

/* frames per 1000 s (60099 for an NTSC console) and samples per second, as the core reports them */
EXPORT(mgu_fps_milli) unsigned mgu_fps_milli(void) { return loaded ? (unsigned)(av.timing.fps * 1000.0 + 0.5) : 0; }
EXPORT(mgu_sample_rate) unsigned mgu_sample_rate(void) { return loaded ? (unsigned)(av.timing.sample_rate + 0.5) : 0; }

EXPORT(mgu_state_size) unsigned mgu_state_size(void) { return loaded ? (unsigned)retro_serialize_size() : 0; }
EXPORT(mgu_state_save) int mgu_state_save(void *p, unsigned n) { return loaded && retro_serialize(p, n) ? 1 : 0; }
EXPORT(mgu_state_load) int mgu_state_load(const void *p, unsigned n) { return loaded && retro_unserialize(p, n) ? 1 : 0; }

EXPORT(mgu_sram_ptr) void *mgu_sram_ptr(void) { return loaded ? retro_get_memory_data(RETRO_MEMORY_SAVE_RAM) : NULL; }
EXPORT(mgu_sram_size) unsigned mgu_sram_size(void) { return loaded ? (unsigned)retro_get_memory_size(RETRO_MEMORY_SAVE_RAM) : 0; }
