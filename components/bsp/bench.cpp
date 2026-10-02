#include <LovyanGFX.hpp>

#include <inttypes.h>
#include <stdlib.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "bsp.h"
#include "bsp_bench.h"

// Phase 0 of the video work: find out what this panel can actually do before
// designing around a guess. Three render paths are timed separately, because the
// bottleneck is not obvious:
//
//   a. decode -> PSRAM sprite -> pushSprite     what the firmware does today
//   b. decode -> straight to the panel          no full-frame buffer at all
//   c. decode -> internal DMA sprite -> DMA     real DMA, but 115 KB of internal RAM
//
// A PSRAM sprite cannot use DMA (LovyanGFX: "DMA disable with use SPIRAM"), so (a) is
// expected to be a polled CPU push. That is the thing being measured.

static const char *TAG = "bench";

// Set by display.cpp, which owns the panel and the PSRAM canvas.
extern lgfx::LGFX_Device *bsp_bench_lcd();
extern LGFX_Sprite *bsp_bench_canvas();

namespace {

struct stats_t {
    uint32_t n;
    int64_t total, min, max;
};

void note(stats_t &s, int64_t us)
{
    if (s.n == 0 || us < s.min) s.min = us;
    if (us > s.max) s.max = us;
    s.total += us;
    s.n++;
}

void report(const char *what, const stats_t &s)
{
    if (!s.n) return;
    const double avg = (double)s.total / s.n / 1000.0;
    ESP_LOGW(TAG, "  %-34s avg %6.2f ms  min %6.2f  max %6.2f  (%.1f fps if alone)", what, avg,
             s.min / 1000.0, s.max / 1000.0, 1000.0 / avg);
}

} // namespace

extern "C" void bsp_display_bench(const bsp_bench_image_t *images, size_t count, int iterations)
{
    auto *lcd = bsp_bench_lcd();
    auto *canvas = bsp_bench_canvas();
    if (!lcd || !canvas) {
        ESP_LOGE(TAG, "no display; nothing to measure");
        return;
    }
    const int w = bsp_display_width(), h = bsp_display_height();

    ESP_LOGW(TAG, "=== panel bench: %dx%d, %d iterations ===", w, h, iterations);
    ESP_LOGW(TAG, "internal free %u KB, psram free %u KB",
             (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024),
             (unsigned)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) / 1024));

    // ── the push alone, with nothing decoded: the hard floor ──────────────
    {
        stats_t psram_push = {};
        canvas->fillScreen(0x1234);
        for (int i = 0; i < iterations; i++) {
            const int64_t t0 = esp_timer_get_time();
            canvas->pushSprite(lcd, 0, 0);
            note(psram_push, esp_timer_get_time() - t0);
        }
        ESP_LOGW(TAG, "push only, no decode:");
        report("PSRAM sprite -> pushSprite", psram_push);

        // The same push from internal DMA-capable memory, if it will fit.
        LGFX_Sprite dma(lcd);
        dma.setPsram(false);
        dma.setColorDepth(16);
        if (dma.createSprite(w, h)) {
            stats_t dma_push = {};
            dma.fillScreen(0x1234);
            for (int i = 0; i < iterations; i++) {
                const int64_t t0 = esp_timer_get_time();
                dma.pushSprite(lcd, 0, 0);
                note(dma_push, esp_timer_get_time() - t0);
            }
            report("internal sprite -> pushSprite", dma_push);
            dma.deleteSprite();
        } else {
            ESP_LOGW(TAG, "  internal sprite (%d KB) would not allocate; path (c) is out",
                     w * h * 2 / 1024);
        }
    }

    // ── decode, then each of the render paths ─────────────────────────────
    for (size_t img = 0; img < count; img++) {
        const bsp_bench_image_t *pic = &images[img];
        ESP_LOGW(TAG, "%s (%u bytes):", pic->name, (unsigned)pic->len);

        stats_t decode_only = {}, to_panel = {}, whole_a = {};

        for (int i = 0; i < iterations; i++) {
            // (a) decode into the PSRAM canvas, then push it
            int64_t t0 = esp_timer_get_time();
            canvas->drawJpg(pic->data, pic->len, 0, 0, w, h);
            const int64_t decoded = esp_timer_get_time();
            canvas->pushSprite(lcd, 0, 0);
            const int64_t pushed = esp_timer_get_time();
            note(decode_only, decoded - t0);
            note(whole_a, pushed - t0);

            // (b) decode straight to the panel, no intermediate buffer
            t0 = esp_timer_get_time();
            lcd->drawJpg(pic->data, pic->len, 0, 0, w, h);
            note(to_panel, esp_timer_get_time() - t0);

            if ((i & 7) == 0) vTaskDelay(1); // never starve the idle task
        }

        report("decode -> PSRAM sprite", decode_only);
        report("(a) decode + pushSprite", whole_a);
        report("(b) decode straight to panel", to_panel);
    }

    ESP_LOGW(TAG, "=== bench done ===");
}

// Paints a moving pattern as fast as it can and reports the rate, to shake out
// corruption at a higher SPI clock over a long run.
extern "C" void bsp_display_soak(int seconds)
{
    auto *lcd = bsp_bench_lcd();
    auto *canvas = bsp_bench_canvas();
    if (!lcd || !canvas) return;

    const int w = bsp_display_width(), h = bsp_display_height();
    const int64_t until = esp_timer_get_time() + (int64_t)seconds * 1000000;
    uint32_t frames = 0;

    ESP_LOGW(TAG, "soaking the panel for %d s; watch for tearing or garbage", seconds);
    while (esp_timer_get_time() < until) {
        // Hard edges and full-range colour: corruption shows up plainly.
        const int band = (int)(frames % 8);
        canvas->fillScreen(0x0000);
        for (int i = 0; i < 8; i++) {
            const uint16_t c = (i == band) ? 0xFFFF : (uint16_t)(0x1F << (i % 3) * 5);
            canvas->fillRect(i * w / 8, 0, w / 8 + 1, h, c);
        }
        canvas->drawFastHLine(0, (int)(frames * 3 % h), w, 0xFFFF);
        canvas->pushSprite(lcd, 0, 0);
        frames++;
        if ((frames & 7) == 0) vTaskDelay(1);
    }
    ESP_LOGW(TAG, "soak done: %" PRIu32 " frames in %d s = %.1f fps", frames, seconds,
             (double)frames / seconds);
}
