#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/ringbuf.h"
#include "freertos/task.h"

#include "aiterm_ws.h"
#include "bsp.h"
#include "notes.h"

static const char *TAG = "notes";

// Two seconds of 16 kHz mono. Sized in time rather than bytes, because a fixed byte
// count silently halves the depth the moment the rate changes — a mistake already
// made once on the video path.
#define RING_SECONDS 2
#define RING_MAX (128 * 1024)
#define WRITE_CHUNK 1024 // samples handed to I2S at a time
#define CREDIT_EVERY 4096

static struct {
    note_entry_t list[NOTES_MAX];
    int count;
    int filling; // index being built while a list arrives
    bool listed;

    char playing[NOTE_ID_LEN];
    int rate;
    int length_ms;
    int base_ms;   // where the stream started in the clip, for seeking
    bool paused;
    bool running;

    RingbufHandle_t ring;
    TaskHandle_t task;
    size_t freed;      // bytes consumed since the last grant
    size_t ring_bytes;
} n;

// ── the list ──────────────────────────────────────────────────────────────

void notes_refresh(void)
{
    n.filling = 0;
    aiterm_ws_notes_list();
}

void notes_on_list(const char *id, float seconds, const char *at, bool last)
{
    if (id && n.filling < NOTES_MAX) {
        note_entry_t *e = &n.list[n.filling++];
        strlcpy(e->id, id, sizeof(e->id));
        e->seconds = seconds;
        strlcpy(e->at, at ? at : "", sizeof(e->at));
    }
    if (last) {
        n.count = n.filling;
        n.listed = true;
        ESP_LOGI(TAG, "%d voice notes", n.count);
    }
}

int notes_count(void)
{
    return n.count;
}

const note_entry_t *notes_at(int index)
{
    return index >= 0 && index < n.count ? &n.list[index] : NULL;
}

bool notes_listed(void)
{
    return n.listed;
}

// ── playback ──────────────────────────────────────────────────────────────

static void grant(size_t bytes)
{
    if (!bytes) return;
    aiterm_ws_note_ready((int)bytes);
}

static void play_task(void *arg)
{
    while (n.running) {
        if (n.paused) {
            // Not writing is the pause: the speaker's own sample counter is the
            // clock, so it stands still on its own while nothing reaches it.
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        size_t got = 0;
        void *pcm = xRingbufferReceiveUpTo(n.ring, &got, pdMS_TO_TICKS(120), WRITE_CHUNK * sizeof(int16_t));
        if (!pcm) continue; // the server has not kept up; silence is better than a stall
        bsp_speaker_stream_write((const int16_t *)pcm, got / sizeof(int16_t));
        vRingbufferReturnItem(n.ring, pcm);
        n.freed += got;
        if (n.freed >= CREDIT_EVERY) {
            grant(n.freed);
            n.freed = 0;
        }
    }
    n.task = NULL;
    vTaskDelete(NULL);
}

static void teardown(void)
{
    n.running = false;
    for (int i = 0; i < 40 && n.task; i++) vTaskDelay(pdMS_TO_TICKS(10));
    bsp_speaker_stream_end();
    if (n.ring) {
        vRingbufferDeleteWithCaps(n.ring);
        n.ring = NULL;
    }
    n.playing[0] = '\0';
    n.paused = false;
}

void notes_play(const char *id, int from_ms)
{
    if (!id || !*id) return;
    // Copied before anything else touches the state. Seeking calls this with
    // notes_current(), which points straight at n.playing — and notes_stop() below
    // clears exactly that. Passing the pointer through would ask the server to play
    // an id of "", which is what a seek did until this line existed.
    char want[NOTE_ID_LEN];
    strlcpy(want, id, sizeof(want));
    if (n.running) notes_stop();
    aiterm_ws_note_play(want, from_ms);
}

void notes_on_start(const char *id, int rate, float seconds, int from_ms)
{
    if (n.running) teardown();

    strlcpy(n.playing, id ? id : "", sizeof(n.playing));
    n.rate = rate > 0 ? rate : 16000;
    n.length_ms = (int)(seconds * 1000.0f);
    n.base_ms = from_ms;
    n.paused = false;
    n.freed = 0;

    size_t bytes = (size_t)n.rate * sizeof(int16_t) * RING_SECONDS;
    if (bytes > RING_MAX) bytes = RING_MAX;
    n.ring_bytes = bytes;
    n.ring = xRingbufferCreateWithCaps(bytes, RINGBUF_TYPE_BYTEBUF, MALLOC_CAP_SPIRAM);
    if (!n.ring) {
        ESP_LOGE(TAG, "no room for the audio ring");
        n.playing[0] = '\0';
        return;
    }

    bsp_speaker_stream_begin(n.rate);
    n.running = true;
    if (xTaskCreatePinnedToCore(play_task, "note", 4096, NULL, 6, &n.task, 0) != pdPASS) {
        ESP_LOGE(TAG, "no room for the playback task");
        teardown();
        return;
    }
    ESP_LOGI(TAG, "playing %.8s: %.1fs at %d Hz from %d ms", n.playing, (double)seconds, n.rate, from_ms);
    grant(n.ring_bytes); // the whole ring is free to begin with
}

void notes_on_audio(const uint8_t *pcm, size_t bytes, uint32_t pts_ms)
{
    if (!n.running || !n.ring) return;
    if (xRingbufferSend(n.ring, pcm, bytes, 0) != pdTRUE) {
        // Credit should prevent this; counted rather than logged per chunk.
        ESP_LOGW(TAG, "the ring overran");
    }
}

void notes_on_seek(int from_ms)
{
    n.base_ms = from_ms;
    // Everything buffered belongs to where we just were.
    if (n.ring) {
        size_t got = 0;
        while (true) {
            void *p = xRingbufferReceiveUpTo(n.ring, &got, 0, WRITE_CHUNK * sizeof(int16_t));
            if (!p) break;
            vRingbufferReturnItem(n.ring, p);
        }
        grant(n.ring_bytes);
    }
}

void notes_on_end(const char *reason)
{
    if (!n.running) return;
    ESP_LOGI(TAG, "note finished (%s)", reason ? reason : "");
    teardown();
}

void notes_stop(void)
{
    if (!n.running) return;
    aiterm_ws_note_stop();
    teardown();
}

void notes_pause(bool paused)
{
    if (n.running) n.paused = paused;
}

bool notes_playing(void)
{
    return n.running;
}

bool notes_paused(void)
{
    return n.running && n.paused;
}

const char *notes_current(void)
{
    return n.playing;
}

int notes_position_ms(void)
{
    if (!n.running) return 0;
    // What the speaker has actually played, not what has been sent — the same
    // distinction that made video's clock trustworthy.
    return n.base_ms + (int)bsp_speaker_stream_clock_ms();
}

int notes_length_ms(void)
{
    return n.length_ms;
}

void notes_init(void)
{
    memset(&n, 0, sizeof(n));
}
