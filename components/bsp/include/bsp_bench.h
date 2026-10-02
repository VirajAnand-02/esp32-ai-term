#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Phase 0 measurement for video playback. Temporary: delete once the render path
// and frame-rate target have been chosen from the numbers.

typedef struct {
    const char *name;
    const uint8_t *data;
    size_t len;
} bsp_bench_image_t;

// Times decode and push separately across the candidate render paths, and logs it.
void bsp_display_bench(const bsp_bench_image_t *images, size_t count, int iterations);

// Hammers the panel with hard-edged colour for a while, to expose corruption at a
// higher SPI clock.
void bsp_display_soak(int seconds);

#ifdef __cplusplus
}
#endif
