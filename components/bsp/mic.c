#include "driver/i2s_std.h"
#include "esp_check.h"
#include "esp_log.h"

#include "bsp.h"

// INMP441 (or any I2S MEMS mic): 32-bit slots, mono, left channel (L/R tied low).

static const char *TAG = "bsp.mic";

static i2s_chan_handle_t s_rx;
static int s_gain_shift = 16;
static uint32_t s_sample_rate;
static uint32_t s_clipped; // samples that hit the 16-bit rails since the last reset

esp_err_t bsp_mic_init(const bsp_mic_config_t *cfg)
{
    if (cfg->bclk_gpio < 0 || cfg->ws_gpio < 0 || cfg->din_gpio < 0) return ESP_ERR_INVALID_ARG;
    s_gain_shift = cfg->gain_shift > 0 ? cfg->gain_shift : 16;
    s_sample_rate = cfg->sample_rate ? cfg->sample_rate : 16000;

    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_AUTO, I2S_ROLE_MASTER);
    chan_cfg.dma_desc_num = 6;
    chan_cfg.dma_frame_num = 240;
    ESP_RETURN_ON_ERROR(i2s_new_channel(&chan_cfg, NULL, &s_rx), TAG, "new channel");

    i2s_std_config_t std = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(s_sample_rate),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = cfg->bclk_gpio,
            .ws = cfg->ws_gpio,
            .dout = I2S_GPIO_UNUSED,
            .din = cfg->din_gpio,
            .invert_flags = {false, false, false},
        },
    };
    std.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT; // L/R pin is tied to GND
    ESP_RETURN_ON_ERROR(i2s_channel_init_std_mode(s_rx, &std), TAG, "init std");
    ESP_LOGI(TAG, "mic ready on bclk=%d ws=%d din=%d @ %" PRIu32 " Hz", cfg->bclk_gpio, cfg->ws_gpio, cfg->din_gpio, s_sample_rate);
    return ESP_OK;
}

void bsp_mic_set_gain_shift(int shift)
{
    if (shift < 8 || shift > 24) return;
    s_gain_shift = shift;
    ESP_LOGI(TAG, "mic gain shift → %d", shift);
}

int bsp_mic_gain_shift(void)
{
    return s_gain_shift;
}

uint32_t bsp_mic_clipped_reset(void)
{
    uint32_t n = s_clipped;
    s_clipped = 0;
    return n;
}

bool bsp_mic_available(void)
{
    return s_rx != NULL;
}

uint32_t bsp_mic_sample_rate(void)
{
    return s_sample_rate;
}

esp_err_t bsp_mic_start(void)
{
    return s_rx ? i2s_channel_enable(s_rx) : ESP_ERR_INVALID_STATE;
}

esp_err_t bsp_mic_stop(void)
{
    return s_rx ? i2s_channel_disable(s_rx) : ESP_ERR_INVALID_STATE;
}

esp_err_t bsp_mic_read(int16_t *dst, size_t samples, size_t *read, uint32_t timeout_ms)
{
    if (!s_rx) return ESP_ERR_INVALID_STATE;
    // The mic gives 32-bit words; convert in place, back to front, into 16-bit samples.
    int32_t *raw = (int32_t *)dst;
    size_t got = 0;
    ESP_RETURN_ON_ERROR(i2s_channel_read(s_rx, raw, samples * sizeof(int32_t), &got, timeout_ms), TAG, "read");

    const size_t n = got / sizeof(int32_t);
    for (size_t i = 0; i < n; i++) {
        int32_t v = raw[i] >> s_gain_shift;
        if (v > INT16_MAX) {
            v = INT16_MAX;
            s_clipped++;
        } else if (v < INT16_MIN) {
            v = INT16_MIN;
            s_clipped++;
        }
        dst[i] = (int16_t)v;
    }
    *read = n;
    return ESP_OK;
}
