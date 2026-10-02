#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_websocket_client.h"

#include "aiterm_ws.h"

static const char *TAG = "aiterm";

#define RX_MAX          16384
#define IMAGE_MAX       (96 * 1024) // a 240x240 JPEG is nearer 15 KB; this is slack
#define VIDEO_HEADER    8           // type u8, pad, stream u16 LE, pts u32 LE.
                                    // 8 rather than 7 so the PCM after it is
                                    // 2-byte aligned; an odd offset makes the
                                    // int16 cast below read rubbish.

// Defined below, next to the frame reassembly they belong with.
static void begin_image(const cJSON *frame);
static void feed_image(const uint8_t *data, size_t len);
#define SEND_TIMEOUT_MS 5000
#define TOOL_QUEUE_LEN  4

typedef struct {
    char call_id[64];
    char name[32];
    cJSON *args; // owned by the worker
} tool_job_t;

static struct {
    esp_websocket_client_handle_t client;
    aiterm_ws_config_t cfg;
    QueueHandle_t tool_jobs;
    char *rx;      // reassembly buffer for fragmented text frames
    size_t rx_len;
    bool rx_binary; // the message being reassembled is binary, not text
    bool video_on;  // between video.start and video.stop, binary is media not an image
    bool note_on;   // ... and the same while a voice note is streaming down
    uint8_t *img;   // an incoming image, announced by image.show
    size_t img_len;
    size_t img_want;
    bool welcomed;
} s;

static void notify_state(aiterm_state_t state)
{
    if (s.cfg.on_state) s.cfg.on_state(state, s.cfg.ctx);
}

static esp_err_t send_json(cJSON *frame)
{
    if (!frame) return ESP_ERR_NO_MEM;
    char *text = cJSON_PrintUnformatted(frame);
    cJSON_Delete(frame);
    if (!text) return ESP_ERR_NO_MEM;

    esp_err_t err = ESP_OK;
    if (!esp_websocket_client_is_connected(s.client)) {
        err = ESP_ERR_INVALID_STATE;
    } else if (esp_websocket_client_send_text(s.client, text, strlen(text), pdMS_TO_TICKS(SEND_TIMEOUT_MS)) < 0) {
        err = ESP_FAIL;
    }
    free(text);
    return err;
}

static cJSON *frame_new(const char *type)
{
    cJSON *f = cJSON_CreateObject();
    if (f) cJSON_AddStringToObject(f, "type", type);
    return f;
}

// ── outgoing ──────────────────────────────────────────────────────────────

esp_err_t aiterm_ws_chat(const char *text)
{
    cJSON *f = frame_new("chat");
    if (!f) return ESP_ERR_NO_MEM;
    cJSON_AddStringToObject(f, "text", text);
    return send_json(f);
}

esp_err_t aiterm_ws_log(const char *level, const char *msg)
{
    cJSON *f = frame_new("log");
    if (!f) return ESP_ERR_NO_MEM;
    cJSON_AddStringToObject(f, "level", level);
    cJSON_AddStringToObject(f, "msg", msg);
    return send_json(f);
}

// The device's own settings, on the way up. The server keeps them on the device
// row so the dashboard shows what the hardware actually has, rather than the last
// thing the dashboard asked for — the two used to be able to disagree silently.
esp_err_t aiterm_ws_settings(cJSON *settings)
{
    if (!settings) return ESP_ERR_INVALID_ARG;
    cJSON *f = frame_new("settings");
    if (!f) {
        cJSON_Delete(settings);
        return ESP_ERR_NO_MEM;
    }
    cJSON_AddItemToObject(f, "settings", settings);
    return send_json(f);
}

esp_err_t aiterm_ws_wifi_networks(const char *const *ssids, int count, const char *current)
{
    cJSON *f = frame_new("wifi.networks");
    if (!f) return ESP_ERR_NO_MEM;
    cJSON *list = cJSON_AddArrayToObject(f, "ssids");
    for (int i = 0; list && i < count; i++) {
        if (ssids[i] && ssids[i][0]) cJSON_AddItemToArray(list, cJSON_CreateString(ssids[i]));
    }
    cJSON_AddStringToObject(f, "current", current ? current : "");
    return send_json(f);
}

esp_err_t aiterm_ws_event(const char *kind, const char *summary)
{
    cJSON *f = frame_new("event");
    if (!f) return ESP_ERR_NO_MEM;
    cJSON_AddStringToObject(f, "event", kind);
    cJSON_AddStringToObject(f, "summary", summary);
    return send_json(f);
}

esp_err_t aiterm_ws_audio_start(const char *clip_id, int sample_rate, int channels, const char *source,
                                const char *note, bool prompt)
{
    cJSON *f = frame_new("audio.start");
    if (!f) return ESP_ERR_NO_MEM;
    cJSON_AddStringToObject(f, "clip_id", clip_id);
    cJSON_AddNumberToObject(f, "sample_rate", sample_rate);
    cJSON_AddNumberToObject(f, "channels", channels);
    cJSON_AddStringToObject(f, "source", source);
    if (note) cJSON_AddStringToObject(f, "note", note);
    if (prompt) cJSON_AddBoolToObject(f, "prompt", true);
    return send_json(f);
}

esp_err_t aiterm_ws_audio_chunk(const void *pcm, size_t bytes)
{
    if (!esp_websocket_client_is_connected(s.client)) return ESP_ERR_INVALID_STATE;
    int sent = esp_websocket_client_send_bin(s.client, (const char *)pcm, bytes, pdMS_TO_TICKS(SEND_TIMEOUT_MS));
    return sent < 0 ? ESP_FAIL : ESP_OK;
}

// Tells the server how much room is left, so it never sends more than fits.
// What the keys asked for while a video is playing. The server owns the position,
// because only it can decode from a different point in the file.
esp_err_t aiterm_ws_notes_list(void)
{
    cJSON *f = frame_new("notes.list");
    return f ? send_json(f) : ESP_ERR_NO_MEM;
}

esp_err_t aiterm_ws_note_play(const char *id, int from_ms)
{
    cJSON *f = frame_new("note.play");
    if (!f) return ESP_ERR_NO_MEM;
    cJSON_AddStringToObject(f, "id", id ? id : "");
    cJSON_AddNumberToObject(f, "from_ms", from_ms);
    return send_json(f);
}

esp_err_t aiterm_ws_note_stop(void)
{
    cJSON *f = frame_new("note.stop");
    return f ? send_json(f) : ESP_ERR_NO_MEM;
}

esp_err_t aiterm_ws_note_ready(int bytes)
{
    cJSON *f = frame_new("note.ready");
    if (!f) return ESP_ERR_NO_MEM;
    cJSON_AddNumberToObject(f, "bytes", bytes);
    return send_json(f);
}

esp_err_t aiterm_ws_video_control(const char *id, const char *action)
{
    cJSON *f = frame_new("video.control");
    if (!f) return ESP_ERR_NO_MEM;
    cJSON_AddStringToObject(f, "id", id ? id : "");
    cJSON_AddStringToObject(f, "action", action);
    return send_json(f);
}

esp_err_t aiterm_ws_video_ready(const char *id, int video_credits, int audio_credits)
{
    cJSON *f = frame_new("video.ready");
    if (!f) return ESP_ERR_NO_MEM;
    cJSON_AddStringToObject(f, "id", id);
    cJSON_AddNumberToObject(f, "video_credits", video_credits);
    cJSON_AddNumberToObject(f, "audio_credits", audio_credits);
    return send_json(f);
}

esp_err_t aiterm_ws_video_ended(const char *id, int shown, int dropped, const char *reason)
{
    cJSON *f = frame_new("video.ended");
    if (!f) return ESP_ERR_NO_MEM;
    cJSON_AddStringToObject(f, "id", id);
    cJSON_AddNumberToObject(f, "shown", shown);
    cJSON_AddNumberToObject(f, "dropped", dropped);
    if (reason) cJSON_AddStringToObject(f, "reason", reason);
    return send_json(f);
}

esp_err_t aiterm_ws_audio_end(const char *clip_id, bool aborted)
{
    cJSON *f = frame_new("audio.end");
    if (!f) return ESP_ERR_NO_MEM;
    cJSON_AddStringToObject(f, "clip_id", clip_id);
    cJSON_AddBoolToObject(f, "aborted", aborted);
    return send_json(f);
}

esp_err_t aiterm_ws_abort(void)
{
    return send_json(frame_new("abort"));
}

esp_err_t aiterm_ws_new_session(void)
{
    return send_json(frame_new("session.new"));
}

bool aiterm_ws_connected(void)
{
    return s.client && esp_websocket_client_is_connected(s.client) && s.welcomed;
}

static void send_hello(void)
{
    cJSON *f = frame_new("hello");
    if (!f) return;
    cJSON_AddNumberToObject(f, "protocol", AITERM_PROTOCOL_VERSION);
    cJSON_AddStringToObject(f, "fw", s.cfg.fw ? s.cfg.fw : "esp32");
    cJSON_AddStringToObject(f, "hw", CONFIG_IDF_TARGET);

    cJSON *caps = cJSON_AddArrayToObject(f, "capabilities");
    cJSON_AddItemToArray(caps, cJSON_CreateString("chat"));
    cJSON_AddItemToArray(caps, cJSON_CreateString("log"));
    if (s.cfg.tool_count) cJSON_AddItemToArray(caps, cJSON_CreateString("tools"));
    // The server only offers the video tools to firmware that can actually play it.
    if (s.cfg.on_video_frame) cJSON_AddItemToArray(caps, cJSON_CreateString("video"));

    cJSON *tools = cJSON_AddArrayToObject(f, "tools");
    for (size_t i = 0; i < s.cfg.tool_count; i++) {
        const aiterm_tool_t *t = &s.cfg.tools[i];
        cJSON *entry = cJSON_CreateObject();
        cJSON_AddStringToObject(entry, "name", t->name);
        cJSON_AddStringToObject(entry, "description", t->description);
        cJSON_AddItemToObject(entry, "parameters", cJSON_Parse(t->parameters));
        cJSON_AddStringToObject(entry, "risk", t->risk);
        cJSON_AddItemToArray(tools, entry);
    }

    cJSON *access = cJSON_AddObjectToObject(f, "access");
    cJSON_AddStringToObject(access, "level", s.cfg.access_level ? s.cfg.access_level : "standard");
    cJSON_AddBoolToObject(access, "remote_approval", s.cfg.remote_approval);

    send_json(f);
}

// ── tool calls ────────────────────────────────────────────────────────────

static void send_tool_result(const char *call_id, bool ok, const char *output, const char *error)
{
    cJSON *f = frame_new("tool.result");
    if (!f) return;
    cJSON_AddStringToObject(f, "call_id", call_id);
    cJSON_AddBoolToObject(f, "ok", ok);
    cJSON_AddBoolToObject(f, "denied", !ok && error && strstr(error, "unknown tool") != NULL);
    cJSON_AddStringToObject(f, "decided_by", "policy");
    if (ok) {
        cJSON_AddStringToObject(f, "output", output ? output : "");
    } else {
        cJSON_AddStringToObject(f, "error", error ? error : "failed");
    }
    send_json(f);
}

// Tools run here so a slow one (a blink, say) never blocks the protocol.
static void tool_worker(void *arg)
{
    tool_job_t job;
    char out[AITERM_TOOL_OUTPUT_MAX];
    char err[128];

    while (xQueueReceive(s.tool_jobs, &job, portMAX_DELAY) == pdTRUE) {
        const aiterm_tool_t *tool = NULL;
        for (size_t i = 0; i < s.cfg.tool_count; i++) {
            if (strcmp(s.cfg.tools[i].name, job.name) == 0) tool = &s.cfg.tools[i];
        }

        out[0] = err[0] = '\0';
        bool ok = false;
        if (!tool) {
            snprintf(err, sizeof(err), "unknown tool \"%s\" on this device", job.name);
        } else {
            ok = tool->run(job.args, out, sizeof(out), err, sizeof(err));
        }
        ESP_LOGI(TAG, "tool %s → %s", job.name, ok ? out : err);
        send_tool_result(job.call_id, ok, out, err);
        if (s.cfg.on_tool) s.cfg.on_tool(job.name, ok, s.cfg.ctx);
        cJSON_Delete(job.args);
    }
}

// ── incoming ──────────────────────────────────────────────────────────────

static const char *str_of(const cJSON *obj, const char *key, const char *fallback)
{
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    return cJSON_IsString(item) ? item->valuestring : fallback;
}

static void handle_frame(const char *text, size_t len)
{
    cJSON *frame = cJSON_ParseWithLength(text, len);
    if (!frame) {
        ESP_LOGW(TAG, "unparsable frame (%u bytes)", (unsigned)len);
        return;
    }
    const char *type = str_of(frame, "type", "");

    if (strcmp(type, "welcome") == 0) {
        s.welcomed = true;
        ESP_LOGI(TAG, "welcome: %s (protocol v%d)", str_of(frame, "name", "?"),
                 (int)cJSON_GetNumberValue(cJSON_GetObjectItem(frame, "protocol")));
        notify_state(AITERM_CONNECTED);
        // The server's clock, so the device knows the time the instant it connects
        // rather than waiting on SNTP — and at all, on a LAN with no way out.
        if (s.cfg.on_time) {
            const cJSON *epoch = cJSON_GetObjectItemCaseSensitive(frame, "time");
            const cJSON *tz = cJSON_GetObjectItemCaseSensitive(frame, "tz");
            if (cJSON_IsNumber(epoch)) {
                s.cfg.on_time((int64_t)epoch->valuedouble, cJSON_IsString(tz) ? tz->valuestring : NULL, s.cfg.ctx);
            }
        }
        if (s.cfg.on_config) s.cfg.on_config(cJSON_GetObjectItem(frame, "config"), s.cfg.ctx);
    } else if (strcmp(type, "chat.user") == 0) {
        notify_state(AITERM_WORKING);
        if (s.cfg.on_prompt) s.cfg.on_prompt(str_of(frame, "text", ""), str_of(frame, "origin", "web"), s.cfg.ctx);
    } else if (strcmp(type, "chat.delta") == 0) {
        if (s.cfg.on_chat_delta) s.cfg.on_chat_delta(str_of(frame, "text", ""), s.cfg.ctx);
    } else if (strcmp(type, "chat.done") == 0) {
        const cJSON *usage = cJSON_GetObjectItem(frame, "usage");
        notify_state(AITERM_IDLE);
        if (s.cfg.on_chat_done) {
            s.cfg.on_chat_done((int)cJSON_GetNumberValue(cJSON_GetObjectItem(usage, "input")),
                               (int)cJSON_GetNumberValue(cJSON_GetObjectItem(usage, "output")),
                               cJSON_IsTrue(cJSON_GetObjectItem(frame, "aborted")), s.cfg.ctx);
        }
    } else if (strcmp(type, "tool.call") == 0) {
        tool_job_t job = {0};
        strlcpy(job.call_id, str_of(frame, "call_id", ""), sizeof(job.call_id));
        strlcpy(job.name, str_of(frame, "name", ""), sizeof(job.name));
        job.args = cJSON_Duplicate(cJSON_GetObjectItem(frame, "args"), true);
        if (xQueueSend(s.tool_jobs, &job, 0) != pdTRUE) {
            cJSON_Delete(job.args);
            send_tool_result(job.call_id, false, NULL, "device is busy with other tool calls");
        }
    } else if (strcmp(type, "audio.record") == 0) {
        const cJSON *secs = cJSON_GetObjectItem(frame, "seconds");
        if (s.cfg.on_record) s.cfg.on_record(str_of(frame, "clip_id", ""), (int)cJSON_GetNumberValue(secs), s.cfg.ctx);
    } else if (strcmp(type, "video.start") == 0) {
        s.video_on = true;
        const cJSON *audio = cJSON_GetObjectItemCaseSensitive(frame, "audio");
        const cJSON *rate = cJSON_IsObject(audio) ? cJSON_GetObjectItem(audio, "rate") : NULL;
        const cJSON *fps = cJSON_GetObjectItem(frame, "fps");
        const cJSON *w = cJSON_GetObjectItem(frame, "w");
        const cJSON *h = cJSON_GetObjectItem(frame, "h");
        if (s.cfg.on_video_start) {
            s.cfg.on_video_start(str_of(frame, "id", ""), (int)cJSON_GetNumberValue(w),
                                 (int)cJSON_GetNumberValue(h), (int)cJSON_GetNumberValue(fps),
                                 cJSON_IsNumber(rate) ? (int)rate->valuedouble : 0, s.cfg.ctx);
        }
    } else if (strcmp(type, "notes") == 0) {
        const cJSON *arr = cJSON_GetObjectItemCaseSensitive(frame, "notes");
        const int total = cJSON_GetArraySize(arr);
        if (total == 0 && s.cfg.on_notes) {
            s.cfg.on_notes(NULL, 0, NULL, true, s.cfg.ctx); // an empty list still ends
        }
        for (int i = 0; i < total; i++) {
            const cJSON *e = cJSON_GetArrayItem(arr, i);
            if (!s.cfg.on_notes) break;
            s.cfg.on_notes(str_of(e, "id", ""), (float)cJSON_GetNumberValue(cJSON_GetObjectItem(e, "seconds")),
                           str_of(e, "at", ""), i == total - 1, s.cfg.ctx);
        }
    } else if (strcmp(type, "note.start") == 0) {
        s.note_on = true;
        if (s.cfg.on_note_start) {
            s.cfg.on_note_start(str_of(frame, "id", ""),
                                (int)cJSON_GetNumberValue(cJSON_GetObjectItem(frame, "rate")),
                                (float)cJSON_GetNumberValue(cJSON_GetObjectItem(frame, "seconds")),
                                (int)cJSON_GetNumberValue(cJSON_GetObjectItem(frame, "from_ms")), s.cfg.ctx);
        }
    } else if (strcmp(type, "note.seek") == 0) {
        if (s.cfg.on_note_seek) {
            s.cfg.on_note_seek((int)cJSON_GetNumberValue(cJSON_GetObjectItem(frame, "from_ms")), s.cfg.ctx);
        }
    } else if (strcmp(type, "note.end") == 0) {
        s.note_on = false;
        if (s.cfg.on_note_end) s.cfg.on_note_end(str_of(frame, "reason", ""), s.cfg.ctx);
    } else if (strcmp(type, "notice") == 0) {
        if (s.cfg.on_notice) s.cfg.on_notice(str_of(frame, "msg", ""), s.cfg.ctx);
    } else if (strcmp(type, "stage") == 0) {
        if (s.cfg.on_stage) s.cfg.on_stage(str_of(frame, "label", ""), str_of(frame, "detail", ""), s.cfg.ctx);
    } else if (strcmp(type, "video.pause") == 0) {
        if (s.cfg.on_video_pause) {
            const cJSON *p = cJSON_GetObjectItemCaseSensitive(frame, "paused");
            s.cfg.on_video_pause(cJSON_IsTrue(p), s.cfg.ctx);
        }
    } else if (strcmp(type, "video.flush") == 0) {
        if (s.cfg.on_video_flush) s.cfg.on_video_flush(s.cfg.ctx);
    } else if (strcmp(type, "video.stop") == 0) {
        s.video_on = false;
        if (s.cfg.on_video_stop) {
            s.cfg.on_video_stop(str_of(frame, "id", ""), str_of(frame, "reason", ""), s.cfg.ctx);
        }
    } else if (strcmp(type, "image.show") == 0) {
        begin_image(frame);
    } else if (strcmp(type, "tool.cancel") == 0) {
        ESP_LOGW(TAG, "tool call cancelled: %s", str_of(frame, "reason", ""));
    } else if (strcmp(type, "config") == 0) {
        if (s.cfg.on_config) s.cfg.on_config(cJSON_GetObjectItem(frame, "config"), s.cfg.ctx);
    } else if (strcmp(type, "wifi.add") == 0) {
        if (s.cfg.on_wifi_add) {
            s.cfg.on_wifi_add(str_of(frame, "ssid", ""), str_of(frame, "password", ""), s.cfg.ctx);
        }
    } else if (strcmp(type, "wifi.forget") == 0) {
        if (s.cfg.on_wifi_forget) s.cfg.on_wifi_forget(str_of(frame, "ssid", ""), s.cfg.ctx);
    } else if (strcmp(type, "session") == 0) {
        ESP_LOGI(TAG, "new session");
    } else if (strcmp(type, "error") == 0) {
        const char *msg = str_of(frame, "msg", "unknown error");
        ESP_LOGE(TAG, "server: %s", msg);
        notify_state(AITERM_FAILED);
        if (s.cfg.on_error) s.cfg.on_error(msg, s.cfg.ctx);
    }
    cJSON_Delete(frame);
}

// The server announces an image, then sends the bytes as binary frames.
static void begin_image(const cJSON *frame)
{
    const cJSON *bytes = cJSON_GetObjectItemCaseSensitive(frame, "bytes");
    const size_t want = cJSON_IsNumber(bytes) ? (size_t)bytes->valuedouble : 0;

    free(s.img);
    s.img = NULL;
    s.img_len = 0;
    s.img_want = 0;

    if (want == 0 || want > IMAGE_MAX) {
        ESP_LOGW(TAG, "image of %u bytes refused (limit %u)", (unsigned)want, (unsigned)IMAGE_MAX);
        return;
    }
    // Images are large and short-lived, so they belong in PSRAM.
    s.img = heap_caps_malloc(want, MALLOC_CAP_SPIRAM);
    if (!s.img) s.img = malloc(want);
    if (!s.img) {
        ESP_LOGW(TAG, "no room for a %u byte image", (unsigned)want);
        return;
    }
    s.img_want = want;
}

static void feed_image(const uint8_t *data, size_t len)
{
    if (!s.img || s.img_len + len > s.img_want) return;
    memcpy(s.img + s.img_len, data, len);
    s.img_len += len;
    if (s.img_len < s.img_want) return;

    if (s.cfg.on_image) s.cfg.on_image(s.img, s.img_len, s.cfg.ctx);
    free(s.img);
    s.img = NULL;
    s.img_len = s.img_want = 0;
}

// While a stream is running every binary message is media: a small header says
// which kind, and when it should be presented.
static void feed_media(const uint8_t *data, size_t len)
{
    if (len < VIDEO_HEADER) return;
    const uint8_t kind = data[0];
    const uint32_t pts = (uint32_t)data[4] | ((uint32_t)data[5] << 8) | ((uint32_t)data[6] << 16) |
                         ((uint32_t)data[7] << 24);
    const uint8_t *payload = data + VIDEO_HEADER;
    const size_t payload_len = len - VIDEO_HEADER;

    if (kind == 1 && s.cfg.on_video_frame) {
        s.cfg.on_video_frame(payload, payload_len, pts, s.cfg.ctx);
    } else if (kind == 2 && s.cfg.on_video_audio) {
        s.cfg.on_video_audio((const int16_t *)payload, payload_len / sizeof(int16_t), pts, s.cfg.ctx);
    } else if (kind == 3 && s.cfg.on_note_audio) {
        s.cfg.on_note_audio(payload, payload_len, pts, s.cfg.ctx);
    }
}

// Frames can arrive in pieces; collect them until the payload is complete.
static void collect(const esp_websocket_event_data_t *e)
{
    if ((size_t)e->payload_len > (s.rx_binary ? IMAGE_MAX : RX_MAX)) {
        ESP_LOGW(TAG, "frame too big (%d bytes), dropped", e->payload_len);
        return;
    }
    if (e->payload_offset == 0) {
        free(s.rx);
        // An image is far larger than any JSON frame, so keep it out of internal RAM.
        s.rx = s.rx_binary ? heap_caps_malloc(e->payload_len + 1, MALLOC_CAP_SPIRAM)
                           : malloc(e->payload_len + 1);
        s.rx_len = 0;
        if (!s.rx) return;
    }
    if (!s.rx) return;
    memcpy(s.rx + e->payload_offset, e->data_ptr, e->data_len);
    s.rx_len = e->payload_offset + e->data_len;
    if (s.rx_len < (size_t)e->payload_len) return; // more to come

    if (s.rx_binary) {
        if (s.video_on || s.note_on) feed_media((const uint8_t *)s.rx, s.rx_len);
        else feed_image((const uint8_t *)s.rx, s.rx_len);
    } else {
        s.rx[s.rx_len] = '\0';
        handle_frame(s.rx, s.rx_len);
    }
    free(s.rx);
    s.rx = NULL;
    s.rx_len = 0;
}

static void on_ws_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    const esp_websocket_event_data_t *e = data;
    switch (id) {
    case WEBSOCKET_EVENT_CONNECTED:
        ESP_LOGI(TAG, "connected to %s", s.cfg.uri);
        send_hello();
        break;
    case WEBSOCKET_EVENT_DATA:
        if (e->op_code == 0x01 || e->op_code == 0x02) s.rx_binary = e->op_code == 0x02;
        if (e->op_code <= 0x02) collect(e); // text, binary, or a continuation of either
        if (e->op_code == 0x08) ESP_LOGW(TAG, "server closed the connection");
        break;
    case WEBSOCKET_EVENT_ERROR:
        ESP_LOGW(TAG, "websocket error (will retry)");
        break;
    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED:
        if (s.welcomed) ESP_LOGW(TAG, "disconnected, retrying");
        s.welcomed = false;
        free(s.rx);
        s.rx = NULL;
        free(s.img);
        s.img = NULL;
        s.img_len = s.img_want = 0;
        if (s.video_on) {
            s.video_on = false;
            if (s.cfg.on_video_stop) s.cfg.on_video_stop("", "disconnected", s.cfg.ctx);
        }
        notify_state(AITERM_DISCONNECTED);
        break;
    default:
        break;
    }
}

esp_err_t aiterm_ws_start(const aiterm_ws_config_t *cfg)
{
    if (!cfg->uri || !cfg->token || !cfg->token[0]) {
        ESP_LOGE(TAG, "server uri and device token are required (see main/config.h)");
        return ESP_ERR_INVALID_ARG;
    }
    s.cfg = *cfg;

    s.tool_jobs = xQueueCreate(TOOL_QUEUE_LEN, sizeof(tool_job_t));
    if (!s.tool_jobs) return ESP_ERR_NO_MEM;
    if (xTaskCreate(tool_worker, "aiterm_tools", 4096, NULL, 5, NULL) != pdPASS) return ESP_ERR_NO_MEM;

    // The token goes in the query string: it survives redirects and needs no custom headers.
    static char uri[256];
    snprintf(uri, sizeof(uri), "%s%stoken=%s", cfg->uri, strchr(cfg->uri, '?') ? "&" : "?", cfg->token);

    esp_websocket_client_config_t ws = {
        .uri = uri,
        .reconnect_timeout_ms = 5000,
        .network_timeout_ms = 10000,
        .buffer_size = 4096,
        .task_stack = 6144,
        // 0 does NOT mean "do not ping": the library reads it as "use the default",
        // which is every 10 seconds (WEBSOCKET_PING_INTERVAL_SEC). So the old comment
        // here was wrong and the device was transmitting six times a minute for no
        // reason. The server's own heartbeat is every 20 s and the library answers
        // those pongs by itself, so this only needs to be often enough to notice a
        // link that has died silently.
        .ping_interval_sec = 30,
    };
    if (strncmp(cfg->uri, "wss://", 6) == 0) ws.crt_bundle_attach = esp_crt_bundle_attach;

    s.client = esp_websocket_client_init(&ws);
    if (!s.client) return ESP_FAIL;
    ESP_ERROR_CHECK(esp_websocket_register_events(s.client, WEBSOCKET_EVENT_ANY, on_ws_event, NULL));
    ESP_LOGI(TAG, "connecting to %s", cfg->uri);
    return esp_websocket_client_start(s.client);
}
