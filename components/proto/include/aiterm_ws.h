#pragma once

#include <stdbool.h>
#include <stddef.h>
#include "cJSON.h"
#include "esp_err.h"

// Client for the AI-TERM server, protocol v1 (see ai-server/PROTOCOL.md).
// The agent runs on the server; this device offers tools and shows what happens.

#define AITERM_PROTOCOL_VERSION 1
#define AITERM_TOOL_OUTPUT_MAX  1024

typedef enum {
    AITERM_DISCONNECTED,
    AITERM_CONNECTED, // welcome received
    AITERM_WORKING,   // a turn is running (prompt sent, or one arrived from the dashboard)
    AITERM_IDLE,      // turn finished
    AITERM_FAILED,    // server reported an error
} aiterm_state_t;

// A tool this device offers. `run` fills `out` and returns true, or fills `err` and returns false.
// It runs on a worker task, so it may block for a moment (but keep it short).
typedef struct {
    const char *name;
    const char *description;
    const char *parameters; // JSON Schema, as a JSON string
    const char *risk;       // info | read | create | modify | destructive | exec
    bool (*run)(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len);
} aiterm_tool_t;

typedef struct {
    const char *uri;   // ws://host:port/ws or wss://…
    const char *token; // device token from the dashboard
    const char *fw;
    const char *access_level;
    bool remote_approval;
    const aiterm_tool_t *tools;
    size_t tool_count;

    // Callbacks (from the websocket task; keep them quick and don't call aiterm_ws_* that block).
    void (*on_state)(aiterm_state_t state, void *ctx);
    void (*on_chat_delta)(const char *text, void *ctx);
    void (*on_chat_done)(int input_tokens, int output_tokens, bool aborted, void *ctx);
    void (*on_prompt)(const char *text, const char *origin, void *ctx); // a prompt from the dashboard
    void (*on_tool)(const char *name, bool ok, void *ctx);
    void (*on_error)(const char *msg, void *ctx);
    // The dashboard asked for a recording: capture `seconds` and upload it as `clip_id`.
    void (*on_record)(const char *clip_id, int seconds, void *ctx);
    // A picture, already cropped and scaled for this panel by the server.
    void (*on_image)(const uint8_t *jpeg, size_t len, void *ctx);

    // Video playback. Frames and audio arrive as binary messages between
    // on_video_start and on_video_stop, each already sized for this panel.
    void (*on_video_start)(const char *id, int w, int h, int fps, int audio_rate, void *ctx);
    void (*on_video_frame)(const uint8_t *jpeg, size_t len, uint32_t pts_ms, void *ctx);
    void (*on_video_audio)(const int16_t *pcm, size_t samples, uint32_t pts_ms, void *ctx);
    void (*on_video_stop)(const char *id, const char *reason, void *ctx);
    void (*on_video_pause)(bool paused, void *ctx);
    void (*on_video_flush)(void *ctx); // a seek happened; drop what is buffered

    // Voice notes played back on the device's speaker. The list arrives one entry
    // at a time with `last` set on the final one, which avoids an array to own.
    void (*on_notes)(const char *id, float seconds, const char *at, bool last, void *ctx);
    void (*on_note_start)(const char *id, int rate, float seconds, int from_ms, void *ctx);
    void (*on_note_audio)(const uint8_t *pcm, size_t bytes, uint32_t pts_ms, void *ctx);
    void (*on_note_seek)(int from_ms, void *ctx);
    void (*on_note_end)(const char *reason, void *ctx);
    void (*on_config)(const cJSON *config, void *ctx);
    // The server's clock and timezone, from the welcome frame.
    void (*on_time)(int64_t utc, const char *tz, void *ctx);
    // Worth saying, but not a failure. Silence after a mic press lands here.
    void (*on_notice)(const char *msg, void *ctx);
    // What the turn is doing, so the sending splash can move on from "transcribing".
    void (*on_stage)(const char *label, const char *detail, void *ctx);
    // A network added or removed from the dashboard. Not part of `config`, because
    // settings carry numbers and bools on both sides and an SSID is a string — one
    // string in that object would fail the server's schema and take every settings
    // report down with it.
    void (*on_wifi_add)(const char *ssid, const char *password, void *ctx);
    void (*on_wifi_forget)(const char *ssid, void *ctx);
    void *ctx;
} aiterm_ws_config_t;

esp_err_t aiterm_ws_start(const aiterm_ws_config_t *cfg);

bool aiterm_ws_connected(void);

// Sends a prompt into this device's session on the server.
esp_err_t aiterm_ws_chat(const char *text);

// ─── audio upload: start, then chunks of 16-bit PCM, then end ─────────────
// `prompt` asks the server to transcribe the clip and run it as a turn, which is
// what the push-to-talk button does.
esp_err_t aiterm_ws_audio_start(const char *clip_id, int sample_rate, int channels, const char *source,
                                const char *note, bool prompt);
esp_err_t aiterm_ws_audio_chunk(const void *pcm, size_t bytes);
esp_err_t aiterm_ws_audio_end(const char *clip_id, bool aborted);

// Video flow control: how many frames and audio bytes the device still has room
// for, and a final report when playback ends.
esp_err_t aiterm_ws_video_ready(const char *id, int video_credits, int audio_credits);

// "pause", "resume", "seek_back" or "seek_fwd", from the keys during playback.
esp_err_t aiterm_ws_video_control(const char *id, const char *action);

// Voice notes: ask for the list, play one (optionally part way in), stop, and grant
// the server room for more audio as the ring drains.
esp_err_t aiterm_ws_notes_list(void);
esp_err_t aiterm_ws_note_play(const char *id, int from_ms);
esp_err_t aiterm_ws_note_stop(void);
esp_err_t aiterm_ws_note_ready(int bytes);
esp_err_t aiterm_ws_video_ended(const char *id, int shown, int dropped, const char *reason);

esp_err_t aiterm_ws_log(const char *level, const char *msg);
esp_err_t aiterm_ws_event(const char *kind, const char *summary);

// Reports the device's current settings. Takes ownership of the object.
esp_err_t aiterm_ws_settings(cJSON *settings);

// The names of the saved networks and which one is joined. Passwords are never sent
// upward: the dashboard can add one and forget one, and that is all it needs.
esp_err_t aiterm_ws_wifi_networks(const char *const *ssids, int count, const char *current);

// Stops the agent's current turn, or starts a fresh session.
esp_err_t aiterm_ws_abort(void);
esp_err_t aiterm_ws_new_session(void);
