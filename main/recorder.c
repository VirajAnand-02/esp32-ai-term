#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_random.h"

#include "aiterm_ws.h"
#include "bsp.h"
#include "recorder.h"
#include "tools.h"
#include "ui.h"

// Captures from the mic and streams it to the server as raw 16-bit PCM:
// audio.start (JSON) → binary chunks → audio.end (JSON).

static const char *TAG = "rec";

#define CHUNK_SAMPLES 512 // 32 ms at 16 kHz; the buffer holds 32-bit words while converting

typedef struct {
    char clip_id[48];
    int seconds;
    int max_seconds;
    char source[8];
    bool prompt;
    recorder_done_t done;
    void *ctx;
} job_t;

static SemaphoreHandle_t s_busy;
static volatile bool s_stop;   // an open-ended recording has been asked to finish
static volatile bool s_abort;  // ... and to throw the audio away

void recorder_stop(bool abort)
{
    s_abort = abort;
    s_stop = true;
}

void recorder_id(char *out, size_t len)
{
    snprintf(out, len, "%08" PRIx32 "%08" PRIx32, esp_random(), esp_random());
}

bool recorder_active(void)
{
    return s_busy && uxSemaphoreGetCount(s_busy) == 0;
}

static void record_task(void *arg)
{
    job_t *job = arg;
    const uint32_t rate = bsp_mic_sample_rate();
    // Open-ended recordings run until recorder_stop(), with the caller's cap as a
    // backstop so a stuck button cannot record for ever.
    const bool open_ended = job->seconds <= 0;
    const size_t total = (size_t)(open_ended ? job->max_seconds : job->seconds) * rate;
    int32_t *buf = malloc(CHUNK_SAMPLES * sizeof(int32_t)); // int16 output shares this buffer
    char summary[160] = {0};
    bool ok = false;
    size_t captured = 0;
    int peak = 0;

    if (!buf) {
        snprintf(summary, sizeof(summary), "out of memory for the audio buffer");
        goto finish;
    }
    if (bsp_mic_start() != ESP_OK) {
        snprintf(summary, sizeof(summary), "could not start the microphone");
        goto finish;
    }
    if (aiterm_ws_audio_start(job->clip_id, (int)rate, 1, job->source, NULL, job->prompt) != ESP_OK) {
        bsp_mic_stop();
        snprintf(summary, sizeof(summary), "not connected to the server");
        goto finish;
    }

    tools_led_status(48, 0, 0); // red while the mic is live
    bsp_mic_clipped_reset();
    // The INMP441 puts out a loud decaying thump for the first few hundred
    // milliseconds after the clock starts. Drop 250 ms of it, or it dominates
    // the peak reading and gives speech-to-text nothing but a bang to chew on.
    size_t drop = 0;
    while (drop < rate / 4) {
        size_t got = 0;
        if (bsp_mic_read((int16_t *)buf, CHUNK_SAMPLES, &got, 200) != ESP_OK) break;
        drop += got;
    }

    while (captured < total && !s_stop) {
        size_t want = total - captured;
        if (want > CHUNK_SAMPLES) want = CHUNK_SAMPLES;
        size_t got = 0;
        if (bsp_mic_read((int16_t *)buf, want, &got, 300) != ESP_OK || got == 0) break;

        const int16_t *pcm = (const int16_t *)buf;
        int chunk_peak = 0;
        for (size_t i = 0; i < got; i++) {
            int v = pcm[i] < 0 ? -pcm[i] : pcm[i];
            if (v > chunk_peak) chunk_peak = v;
        }
        if (chunk_peak > peak) peak = chunk_peak;
        ui_level((float)chunk_peak / 32768.0f); // drives the meter on the panel
        if (aiterm_ws_audio_chunk(pcm, got * sizeof(int16_t)) != ESP_OK) break;
        captured += got;
    }

    bsp_mic_stop();
    ui_listening_done();
    const bool discarded = s_abort;
    ok = captured > 0 && !discarded;
    aiterm_ws_audio_end(job->clip_id, !ok);
    if (ok) {
        const uint32_t clipped = bsp_mic_clipped_reset();
        const int clipped_pct = captured ? (int)(clipped * 100 / captured) : 0;
        snprintf(summary, sizeof(summary), "recorded %.1fs at %" PRIu32 " Hz, peak %d%%%s (clip %.8s). "
                 "Playable in the dashboard, which can also transcribe it.",
                 (double)captured / rate, rate, peak * 100 / 32768,
                 clipped_pct >= 1 ? ", distorted: mic gain is too high" : "", job->clip_id);
        ESP_LOGI(TAG, "%s", summary);
        if (clipped_pct >= 1) {
            ESP_LOGW(TAG, "%d%% of samples clipped at gain shift %d; raise mic_gain_shift in the device config",
                     clipped_pct, bsp_mic_gain_shift());
        }
    } else if (discarded) {
        snprintf(summary, sizeof(summary), "the recording was cancelled");
    } else {
        snprintf(summary, sizeof(summary), "the microphone returned no audio");
    }

finish:
    free(buf);
    tools_led_idle();
    if (job->done) job->done(ok, summary, job->ctx);
    free(job);
    xSemaphoreGive(s_busy);
    vTaskDelete(NULL);
}

esp_err_t recorder_start(const char *clip_id, int seconds, int max_seconds, const char *source, bool prompt,
                         recorder_done_t done,
                         void *ctx)
{
    if (!bsp_mic_available()) return ESP_ERR_NOT_SUPPORTED;
    s_busy = s_busy ?: xSemaphoreCreateBinary();
    if (!s_busy) return ESP_ERR_NO_MEM;
    static bool primed;
    if (!primed) {
        primed = true;
        xSemaphoreGive(s_busy);
    }
    if (xSemaphoreTake(s_busy, 0) != pdTRUE) return ESP_ERR_INVALID_STATE; // already recording

    job_t *job = calloc(1, sizeof(job_t));
    if (!job) {
        xSemaphoreGive(s_busy);
        return ESP_ERR_NO_MEM;
    }
    strlcpy(job->clip_id, clip_id, sizeof(job->clip_id));
    strlcpy(job->source, source, sizeof(job->source));
    job->seconds = seconds <= 0 ? 0 : (seconds > RECORDER_MAX_SECONDS ? RECORDER_MAX_SECONDS : seconds);
    job->max_seconds = max_seconds > 0 ? max_seconds : RECORDER_MAX_SECONDS;
    job->prompt = prompt;
    s_stop = s_abort = false;
    job->done = done;
    job->ctx = ctx;

    if (xTaskCreate(record_task, "record", 4096, job, 6, NULL) != pdPASS) {
        free(job);
        xSemaphoreGive(s_busy);
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}
