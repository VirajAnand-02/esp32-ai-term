#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/i2s_std.h"
#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "bsp.h"

// MAX98357A class-D amp on I2S. It has no volume register — the GAIN pin sets a
// fixed gain with a resistor — so loudness here is the samples themselves.
//
// SD is not just a mute: held low the amp shuts down, which is also how the hiss
// between sounds is avoided. It is raised just before audio and dropped after.

static const char *TAG = "bsp.spk";

#define FRAMES    512 // per write; ~12 ms at 44.1 kHz
#define DMA_DESCS 4   // buffers in flight; their depth is the playback latency
#define FADE_MS   6   // attack and release, or every tone starts with a click
#define TAIL_MS   25  // silence pushed out before the amp shuts down

static i2s_chan_handle_t s_tx;
static int s_rate;  // the default, used for tones
static int s_clock; // what the hardware is actually clocked at right now
static int s_sd_gpio = -1;
static int s_volume = 70;
static bool s_enabled;
static volatile bool s_stop;
static bool s_streaming;
static uint64_t s_stream_frames; // handed to the hardware since the stream began
static int16_t *s_buf; // FRAMES stereo frames

esp_err_t bsp_speaker_init(const bsp_speaker_config_t *cfg)
{
    if (!cfg || cfg->bclk_gpio < 0 || cfg->ws_gpio < 0 || cfg->dout_gpio < 0) return ESP_ERR_INVALID_ARG;
    s_rate = cfg->sample_rate > 0 ? cfg->sample_rate : 16000;

    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_AUTO, I2S_ROLE_MASTER);
    chan_cfg.dma_desc_num = DMA_DESCS;
    chan_cfg.dma_frame_num = FRAMES;
    chan_cfg.auto_clear = true; // repeat silence, not the last buffer, on underrun
    ESP_RETURN_ON_ERROR(i2s_new_channel(&chan_cfg, &s_tx, NULL), TAG, "new channel");

    const i2s_std_config_t std = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(s_rate),
        // Stereo with the same sample in both slots: the breakout picks left, right
        // or the average depending on how SD is strapped, and this sounds the same
        // whichever it is.
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = cfg->bclk_gpio,
            .ws = cfg->ws_gpio,
            .dout = cfg->dout_gpio,
            .din = I2S_GPIO_UNUSED,
            .invert_flags = {false, false, false},
        },
    };
    ESP_RETURN_ON_ERROR(i2s_channel_init_std_mode(s_tx, &std), TAG, "std mode");
    s_clock = s_rate;

    s_buf = calloc(FRAMES * 2, sizeof(int16_t));
    if (!s_buf) return ESP_ERR_NO_MEM;

    if (cfg->sd_gpio >= 0) {
        s_sd_gpio = cfg->sd_gpio;
        const gpio_config_t io = {
            .pin_bit_mask = 1ULL << cfg->sd_gpio,
            .mode = GPIO_MODE_OUTPUT,
        };
        ESP_RETURN_ON_ERROR(gpio_config(&io), TAG, "sd gpio");
        gpio_set_level(s_sd_gpio, 0); // shut down until there is something to play
    }

    ESP_LOGI(TAG, "MAX98357A ready on bclk=%d ws=%d dout=%d sd=%d @ %d Hz", cfg->bclk_gpio, cfg->ws_gpio,
             cfg->dout_gpio, cfg->sd_gpio, s_rate);
    return ESP_OK;
}

bool bsp_speaker_available(void)
{
    return s_tx != NULL;
}

uint32_t bsp_speaker_sample_rate(void)
{
    return (uint32_t)s_rate;
}

void bsp_speaker_set_volume(int percent)
{
    s_volume = percent < 0 ? 0 : (percent > 100 ? 100 : percent);
}

int bsp_speaker_volume(void)
{
    return s_volume;
}

bool bsp_speaker_enabled(void)
{
    return s_enabled;
}

// Powers the amp up or down. Idle-low keeps the class-D output stage quiet.
void bsp_speaker_enable(bool on)
{
    if (!s_tx || on == s_enabled) return;
    if (on) {
        if (i2s_channel_enable(s_tx) != ESP_OK) return;
        s_stop = false; // a fresh run; anything asked to stop earlier is over
        if (s_sd_gpio >= 0) {
            gpio_set_level(s_sd_gpio, 1);
            vTaskDelay(pdMS_TO_TICKS(5)); // the amp needs a moment to come out of shutdown
        }
    } else {
        if (s_sd_gpio >= 0) gpio_set_level(s_sd_gpio, 0);
        i2s_channel_disable(s_tx);
    }
    s_enabled = on;
}

// Retunes the I2S clock, which can only be done while the channel is stopped.
// Playing 16 kHz audio through a 44.1 kHz channel would come out nearly three
// times too fast, so raw PCM sets the clock to its own rate instead.
static esp_err_t apply_rate(int hz)
{
    if (hz <= 0 || hz == s_clock) return ESP_OK;
    const bool was_on = s_enabled;
    if (was_on) bsp_speaker_enable(false);

    i2s_std_clk_config_t clk = I2S_STD_CLK_DEFAULT_CONFIG((uint32_t)hz);
    const esp_err_t err = i2s_channel_reconfig_std_clock(s_tx, &clk);
    if (err == ESP_OK) s_clock = hz;
    else ESP_LOGW(TAG, "could not clock the speaker at %d Hz: %s", hz, esp_err_to_name(err));

    if (was_on) bsp_speaker_enable(true);
    return err;
}

void bsp_speaker_stop(void)
{
    s_stop = true;
}

static esp_err_t push(size_t frames)
{
    size_t written = 0;
    return i2s_channel_write(s_tx, s_buf, frames * 2 * sizeof(int16_t), &written, pdMS_TO_TICKS(500));
}

// Sine, with a short fade at each end so the cone is never asked to jump.
esp_err_t bsp_speaker_tone(int hz, int ms, int volume)
{
    if (!s_tx) return ESP_ERR_INVALID_STATE;
    if (ms <= 0) return ESP_OK;
    if (volume < 0) volume = s_volume;
    if (volume > 100) volume = 100;

    apply_rate(s_rate);
    if (hz < 20) hz = 20;
    if (hz > s_clock / 2 - 100) hz = s_clock / 2 - 100;

    const bool was_on = s_enabled;
    if (!was_on) bsp_speaker_enable(true);

    const int total = (int)((int64_t)ms * s_clock / 1000);
    const int fade = (int)((int64_t)FADE_MS * s_clock / 1000);
    const float step = 2.0f * (float)M_PI * (float)hz / (float)s_clock;
    const float peak = 32767.0f * 0.8f * (float)volume / 100.0f; // 0.8: leave headroom
    float phase = 0;
    esp_err_t err = ESP_OK;

    for (int done = 0; done < total && !s_stop; ) {
        const int n = (total - done) < FRAMES ? (total - done) : FRAMES;
        for (int i = 0; i < n; i++) {
            const int at = done + i;
            float env = 1.0f;
            if (at < fade) env = (float)at / (float)fade;
            else if (at > total - fade) env = (float)(total - at) / (float)fade;

            const int16_t v = (int16_t)(sinf(phase) * peak * env);
            s_buf[i * 2] = v;     // left
            s_buf[i * 2 + 1] = v; // right
            phase += step;
            if (phase > 2.0f * (float)M_PI) phase -= 2.0f * (float)M_PI;
        }
        err = push(n);
        if (err != ESP_OK) break;
        done += n;
    }

    if (!was_on) {
        bsp_speaker_silence(TAIL_MS);
        bsp_speaker_enable(false);
    }
    return err;
}

esp_err_t bsp_speaker_silence(int ms)
{
    if (!s_tx || ms <= 0) return ESP_OK;
    const bool was_on = s_enabled;
    if (!was_on) bsp_speaker_enable(true);

    memset(s_buf, 0, FRAMES * 2 * sizeof(int16_t));
    int left = (int)((int64_t)ms * s_clock / 1000);
    esp_err_t err = ESP_OK;
    while (left > 0 && !s_stop) {
        const int n = left < FRAMES ? left : FRAMES;
        err = push(n);
        if (err != ESP_OK) break;
        left -= n;
    }
    if (!was_on) bsp_speaker_enable(false);
    return err;
}

// The chunk loop both the one-shot and the streaming paths share: scale to volume,
// duplicate mono into both slots, hand to I2S.
static esp_err_t write_pcm(const int16_t *pcm, size_t samples)
{
    esp_err_t err = ESP_OK;
    for (size_t done = 0; done < samples && !s_stop; ) {
        const size_t n = (samples - done) < FRAMES ? (samples - done) : FRAMES;
        for (size_t i = 0; i < n; i++) {
            const int16_t v = (int16_t)((int32_t)pcm[done + i] * s_volume / 100);
            s_buf[i * 2] = v;
            s_buf[i * 2 + 1] = v;
        }
        err = push(n);
        if (err != ESP_OK) break;
        done += n;
        s_stream_frames += n;
    }
    return err;
}

// Raw mono PCM, scaled by the current volume. `rate` is the audio's own sample
// rate; the hardware is retuned to match, so nothing has to be resampled. Pass 0
// to use the speaker's default.
esp_err_t bsp_speaker_write(const int16_t *pcm, size_t samples, int rate)
{
    if (!s_tx || !pcm) return ESP_ERR_INVALID_STATE;
    apply_rate(rate > 0 ? rate : s_rate);
    const bool was_on = s_enabled;
    if (!was_on) bsp_speaker_enable(true);

    const esp_err_t err = write_pcm(pcm, samples);

    if (!was_on) {
        bsp_speaker_silence(TAIL_MS);
        bsp_speaker_enable(false);
    }
    return err;
}

// ── continuous playback ───────────────────────────────────────────────────

esp_err_t bsp_speaker_stream_begin(int rate)
{
    if (!s_tx) return ESP_ERR_INVALID_STATE;
    apply_rate(rate > 0 ? rate : s_rate);
    s_stream_frames = 0;
    s_streaming = true;
    bsp_speaker_enable(true); // stays on for the whole stream, so it cannot click
    return ESP_OK;
}

esp_err_t bsp_speaker_stream_write(const int16_t *pcm, size_t samples)
{
    if (!s_streaming || !pcm) return ESP_ERR_INVALID_STATE;
    return write_pcm(pcm, samples);
}

void bsp_speaker_stream_end(void)
{
    if (!s_streaming) return;
    s_streaming = false;
    bsp_speaker_silence(TAIL_MS);
    bsp_speaker_enable(false);
}

bool bsp_speaker_stream_active(void)
{
    return s_streaming;
}

uint32_t bsp_speaker_stream_clock_ms(void)
{
    if (!s_clock) return 0;
    // s_stream_frames counts what has been handed to the DMA, not what has come out
    // of the speaker. The descriptors in flight are a fixed latency ahead of real
    // sound, and video synchronises against this, so subtract them: otherwise every
    // frame looks late by the depth of the buffer and gets dropped.
    const uint64_t in_flight = (uint64_t)DMA_DESCS * FRAMES;
    const uint64_t played = s_stream_frames > in_flight ? s_stream_frames - in_flight : 0;
    return (uint32_t)(played * 1000ULL / (uint64_t)s_clock);
}
