#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/ringbuf.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "aiterm_ws.h"
#include "bsp.h"
#include "ui.h"
#include "video_player.h"

// The terminal's video player.
//
// Two tasks: one drains audio into I2S, which blocks until the DMA has room and so
// paces itself exactly; the other waits for each frame's moment to arrive, decodes it
// straight to the panel and pushes it. Anything that has fallen behind is dropped
// rather than shown late, because the audio cannot be paused to wait for it.

static const char *TAG = "video";

// Four. Eight was tried to deepen the pipeline and made things worse: frames simply
// queued longer and aged past their deadline, so late frames went 14 -> 48 with no
// gain in throughput. A shallow queue is the right shape when late frames are useless.
#define VIDEO_SLOTS   4
#define SLOT_BYTES    (24 * 1024)  // a 240x240 baseline JPEG is nearer 10 KB
#define AUDIO_SECONDS 2            // ring depth in time, so the rate cannot shrink it
#define AUDIO_RING_MAX (256 * 1024)
#define AUDIO_CHUNK   1024         // samples handed to I2S at a time
#define LATE_MS       100          // later than this and the frame is not worth showing
#define CREDIT_EVERY  1            // grant the moment a slot frees; the server is
                                   // otherwise left waiting on a round-trip

typedef struct {
    uint8_t *data;
    size_t len;
    uint32_t pts_ms;
} slot_t;

static struct {
    char id[40];
    bool running;
    int audio_rate;
    int x, y;   // where the frame sits, centred if it is smaller than the panel

    slot_t slots[VIDEO_SLOTS];
    QueueHandle_t ready;  // indices of filled slots, in arrival order
    QueueHandle_t empty;  // indices free to be written
    RingbufHandle_t audio;

    TaskHandle_t video_task;
    TaskHandle_t audio_task;

    int shown, late, failed, overrun;   // why frames did not make it, separately
    bool synced;                        // the two time bases have been aligned
    int odd_splits;                     // ring reads that ended mid-sample
    int underruns;                      // the ring ran dry: this stalls the clock
    size_t ring_bytes;
    int64_t pts_offset;                 // server timeline minus our audio clock
    uint32_t last_audio_ms;             // for spotting a stalled audio clock
    int64_t last_audio_move_us;
    int slots_freed;                    // video slots freed since the last grant
    size_t audio_freed;                 // audio bytes consumed since the last grant
    int64_t started_us;
    bool paused;
    int64_t paused_at_us;   // wall time when the pause began, for the silent clock
    int64_t paused_total_us;
} v;

// With no audio there is nothing to sync to, so the wall clock stands in.
static uint32_t clock_ms(void)
{
    const int64_t now = esp_timer_get_time();
    const int64_t frozen = v.paused ? now - v.paused_at_us : 0;
    if (v.audio_rate <= 0) {
        return (uint32_t)((now - v.started_us - v.paused_total_us - frozen) / 1000);
    }

    const uint32_t audio = bsp_speaker_stream_clock_ms();
    if (audio != v.last_audio_ms) {
        v.last_audio_ms = audio;
        v.last_audio_move_us = now;
        return audio;
    }
    // The audio clock only advances as samples reach the hardware, so it stops dead if
    // the sound underruns. Waiting on a stopped clock would freeze the picture too, so
    // once it has been still for a moment, carry on using wall time.
    const int64_t still_for = now - v.last_audio_move_us;
    if (still_for > 120000) return audio + (uint32_t)((still_for - 120000) / 1000);
    return audio;
}

// Grants more room rather than reporting how much is free. A level is racy: bytes
// already in flight are not yet in the ring, so the server reads the level, tops
// itself back up and overruns us. A grant of "you may send this much more" cannot.
static void give_credit(bool force)
{
    if (!force && v.slots_freed < CREDIT_EVERY && v.audio_freed < 8192) return;
    const int slots = force ? VIDEO_SLOTS : v.slots_freed;
    const size_t bytes = force ? v.ring_bytes : v.audio_freed;
    v.slots_freed = 0;
    v.audio_freed = 0;
    if (slots || bytes) aiterm_ws_video_ready(v.id, slots, (int)bytes);
}

static void audio_worker(void *arg)
{
    while (v.running) {
        if (v.paused) {
            // Not writing is the pause: the speaker's sample counter is the clock,
            // so it stands still on its own while nothing is handed to it.
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        size_t got = 0;
        // i2s_channel_write inside the speaker blocks until DMA has room, so this
        // loop runs at exactly playback speed and needs no timer of its own.
        void *pcm = xRingbufferReceiveUpTo(v.audio, &got, pdMS_TO_TICKS(100), AUDIO_CHUNK * sizeof(int16_t));
        if (!pcm) {
            // Nothing to play. The clock stops here, and video waits on that clock, so
            // an underrun costs far more than the gap in the sound.
            v.underruns++;
            continue;
        }
        // A byte ring can split anywhere in principle, and half a sample would shift
        // everything after it and turn the rest of the stream into noise. Every send is
        // an even 2048 bytes so it should never happen — counted rather than ignored,
        // because if it ever does this is exactly what it would sound like.
        if (got & 1) v.odd_splits++;
        bsp_speaker_stream_write((const int16_t *)pcm, got / sizeof(int16_t));
        vRingbufferReturnItem(v.audio, pcm);
        v.audio_freed += got;
        give_credit(false);
    }
    v.audio_task = NULL;
    vTaskDelete(NULL);
}

static void video_worker(void *arg)
{
    while (v.running) {
        int idx = -1;
        if (xQueueReceive(v.ready, &idx, pdMS_TO_TICKS(100)) != pdTRUE) continue;
        if (!v.running) break;

        slot_t *slot = &v.slots[idx];
        uint32_t now = clock_ms();

        // The server stamps frames from when it began transcoding; our clock starts
        // when the first sample reaches the speaker. For a source like YouTube those
        // origins are seconds apart, so without this every frame looks early, waits
        // the full cap and the cap becomes the frame rate. Align them once, on the
        // first frame, and everything after is relative to that.
        if (!v.synced) {
            v.pts_offset = (int64_t)slot->pts_ms - (int64_t)now;
            v.synced = true;
        }
        const int64_t due_signed = (int64_t)slot->pts_ms - v.pts_offset;
        const uint32_t due = due_signed > 0 ? (uint32_t)due_signed : 0;

        if (due > now + 5) {
            // Early: wait for its moment, but stay responsive to a stop.
            uint32_t wait = due - now;
            if (wait > 250) wait = 250;
            vTaskDelay(pdMS_TO_TICKS(wait));
        }

        // A frame that arrived just before a pause waits it out rather than being
        // judged late against a clock that was standing still.
        while (v.running && v.paused) vTaskDelay(pdMS_TO_TICKS(20));

        if (v.running && clock_ms() > due + LATE_MS) {
            // Too late to matter. Showing it now would only push the next one later.
            v.late++;
        } else if (v.running) {
            if (ui_video_present(slot->data, slot->len, v.x, v.y)) v.shown++;
            else v.failed++;
        }

        xQueueSend(v.empty, &idx, 0);
        v.slots_freed++;
        give_credit(false);
        vTaskDelay(pdMS_TO_TICKS(2)); // never hog the core
    }
    v.video_task = NULL;
    vTaskDelete(NULL);
}

void video_player_start(const char *id, int w, int h, int fps, int audio_rate)
{
    if (v.running) video_player_stop("replaced");
    memset(&v, 0, sizeof(v));
    strlcpy(v.id, id ? id : "", sizeof(v.id));
    v.audio_rate = audio_rate;
    // Centred at its natural size. Upscaling to fill the panel would mean pushing all
    // 240x240 again, which is the cost sending something smaller was meant to avoid.
    v.x = w > 0 ? (bsp_display_width() - w) / 2 : 0;
    v.y = h > 0 ? (bsp_display_height() - h) / 2 : 0;
    if (v.x < 0) v.x = 0;
    if (v.y < 0) v.y = 0;
    v.started_us = esp_timer_get_time();

    v.ready = xQueueCreate(VIDEO_SLOTS, sizeof(int));
    v.empty = xQueueCreate(VIDEO_SLOTS, sizeof(int));
    if (!v.ready || !v.empty) {
        ESP_LOGE(TAG, "no room for the frame queues");
        return;
    }
    for (int i = 0; i < VIDEO_SLOTS; i++) {
        v.slots[i].data = heap_caps_malloc(SLOT_BYTES, MALLOC_CAP_SPIRAM);
        if (!v.slots[i].data) {
            ESP_LOGE(TAG, "no room for frame buffers");
            video_player_stop("out of memory");
            return;
        }
        xQueueSend(v.empty, &i, 0);
    }

    if (audio_rate > 0) {
        size_t ring = (size_t)audio_rate * sizeof(int16_t) * AUDIO_SECONDS;
        if (ring > AUDIO_RING_MAX) ring = AUDIO_RING_MAX;
        v.ring_bytes = ring;
        v.audio = xRingbufferCreateWithCaps(ring, RINGBUF_TYPE_BYTEBUF, MALLOC_CAP_SPIRAM);
        if (!v.audio) {
            ESP_LOGW(TAG, "no room for the audio ring; playing silently");
            v.audio_rate = 0;
        } else {
            bsp_speaker_stream_begin(audio_rate);
        }
    }

    ui_take_panel();
    v.running = true;

    // Audio sits above video: a gap in the sound is far more obvious than a dropped
    // frame, and it is the clock everything else follows.
    xTaskCreatePinnedToCore(video_worker, "video", 4096, NULL, 4, &v.video_task, 1);
    if (v.audio) xTaskCreatePinnedToCore(audio_worker, "video_audio", 4096, NULL, 6, &v.audio_task, 0);

    ESP_LOGI(TAG, "playing %s: %dx%d at %d fps from (%d,%d), audio %d Hz", v.id, w, h, fps, v.x, v.y,
             v.audio_rate);
    give_credit(true);
}

void video_player_pause(bool paused)
{
    if (!v.running || v.paused == paused) return;
    const int64_t now = esp_timer_get_time();
    if (paused) {
        v.paused_at_us = now;
    } else {
        v.paused_total_us += now - v.paused_at_us;
    }
    v.paused = paused;
    ESP_LOGI(TAG, "%s", paused ? "paused" : "resumed");
}

bool video_player_paused(void)
{
    return v.running && v.paused;
}

void video_player_flush(void)
{
    if (!v.running) return;
    // Hand every ready slot back empty, so the decoder has nothing stale to show.
    int idx = -1;
    int freed = 0;
    while (xQueueReceive(v.ready, &idx, 0) == pdTRUE) {
        xQueueSend(v.empty, &idx, 0);
        freed++;
    }
    if (v.audio) {
        size_t got = 0;
        while (true) {
            void *pcm = xRingbufferReceiveUpTo(v.audio, &got, 0, AUDIO_CHUNK * sizeof(int16_t));
            if (!pcm) break;
            vRingbufferReturnItem(v.audio, pcm);
        }
    }
    // The next frame decides where we are now; the old alignment belongs to the
    // position we just left.
    v.synced = false;
    v.slots_freed += freed;
    give_credit(true);
    ESP_LOGI(TAG, "flushed %d queued frames after a seek", freed);
}

void video_player_frame(const uint8_t *jpeg, size_t len, uint32_t pts_ms)
{
    if (!v.running || len > SLOT_BYTES) {
        if (len > SLOT_BYTES) ESP_LOGW(TAG, "frame of %u bytes is too big", (unsigned)len);
        return;
    }
    int idx = -1;
    if (xQueueReceive(v.empty, &idx, 0) != pdTRUE) {
        // Credit should have prevented this; if it happens the frame is simply lost.
        v.overrun++;
        return;
    }
    memcpy(v.slots[idx].data, jpeg, len);
    v.slots[idx].len = len;
    v.slots[idx].pts_ms = pts_ms;
    xQueueSend(v.ready, &idx, 0);
}

void video_player_audio(const int16_t *pcm, size_t samples, uint32_t pts_ms)
{
    if (!v.running || !v.audio) return;
    if (xRingbufferSend(v.audio, pcm, samples * sizeof(int16_t), 0) != pdTRUE) {
        v.overrun++; // counted rather than logged: at 12 fps the log itself costs time
    }
}

void video_player_stop(const char *reason)
{
    if (!v.running) {
        // Still clean up anything a failed start left behind.
        for (int i = 0; i < VIDEO_SLOTS; i++) free(v.slots[i].data);
        if (v.ready) vQueueDelete(v.ready);
        if (v.empty) vQueueDelete(v.empty);
        memset(&v, 0, sizeof(v));
        return;
    }
    v.running = false;

    // Let both workers notice and exit before their buffers go away.
    for (int i = 0; i < 40 && (v.video_task || v.audio_task); i++) vTaskDelay(pdMS_TO_TICKS(10));

    if (v.audio_rate > 0) bsp_speaker_stream_end();
    const int dropped = v.late + v.failed + v.overrun;
    aiterm_ws_video_ended(v.id, v.shown, dropped, reason);
    ESP_LOGI(TAG, "stopped (%s): %d shown, %d late, %d would not decode, %d overran the buffers",
             reason ? reason : "", v.shown, v.late, v.failed, v.overrun);
    if (v.odd_splits) ESP_LOGW(TAG, "%d audio reads split mid-sample", v.odd_splits);
    if (v.underruns) ESP_LOGW(TAG, "%d audio underruns (each one stalls the clock)", v.underruns);

    for (int i = 0; i < VIDEO_SLOTS; i++) free(v.slots[i].data);
    if (v.ready) vQueueDelete(v.ready);
    if (v.empty) vQueueDelete(v.empty);
    if (v.audio) vRingbufferDeleteWithCaps(v.audio);
    memset(&v, 0, sizeof(v));

    ui_give_panel();
}

bool video_player_active(void)
{
    return v.running;
}
