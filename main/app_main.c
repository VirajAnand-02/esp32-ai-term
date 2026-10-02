#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/usb_serial_jtag.h"
#include "esp_err.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_pm.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "nvs_flash.h"

#include "aiclock.h"
#include "aiterm_ws.h"
#include "board_config.h"
#include "bsp.h"
#include "config.h"
#include "net_mdns.h"
#include "notes.h"
#include "net_wifi.h"
#include "notify.h"
#include "wifi_store.h"
#include "recorder.h"
#include "schedule.h"
#include "settings.h"
#include "shell.h"
#include "bsp_bench.h"
#include "sounds.h"
#include "time_tools.h"
#include "tools.h"
#include "ui.h"
#include "video_player.h"
#include "wifi_credentials.h"

static const char *TAG = "app";

// The panel belongs to the ui component. app_main only reports what the terminal
// is doing; nothing here waits on a repaint.

static char s_ip[16];

// The display_* tools park the render loop themselves, so there is nothing left
// for the app to hold. Kept because tools.c calls it around every raw draw.
void app_display_hold(void)
{
}

static void init_nvs(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
}

static void on_wifi_state(net_wifi_state_t state, void *ctx)
{
    switch (state) {
    case NET_WIFI_CONNECTED: {
        tools_led_status(0, 24, 0); // green
        aiclock_start_sntp();
        esp_netif_ip_info_t ip = {0};
        esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
        if (netif && esp_netif_get_ip_info(netif, &ip) == ESP_OK) {
            snprintf(s_ip, sizeof(s_ip), IPSTR, IP2STR(&ip.ip));
        }
        ui_boot("wifi up");
        break;
    }
    case NET_WIFI_SCANNING:
    case NET_WIFI_CONNECTING:
        tools_led_status(24, 12, 0); // amber
        ui_boot(net_wifi_state_name(state));
        break;
    case NET_WIFI_IDLE:
    case NET_WIFI_NO_NETWORK:
    case NET_WIFI_BAD_PASSWORD:
        // Trouble at the wifi level, which had no way onto the screen before: the
        // link line was only ever written from the websocket callback, so a device
        // that could not join anything just sat there saying "starting".
        tools_led_status(24, 0, 0); // red
        ui_link(net_wifi_state_name(state), "");
        break;
    }
}

// The tools live in two files — the hardware ones and the clock's — and hello
// wants a single array. Built once, small, and never freed, which is the whole of
// its lifecycle.
static const aiterm_tool_t *all_tools(size_t *count)
{
    static aiterm_tool_t *merged;
    static size_t n;
    if (!merged) {
        n = DEVICE_TOOL_COUNT + TIME_TOOL_COUNT;
        merged = malloc(sizeof(aiterm_tool_t) * n);
        if (!merged) {
            *count = DEVICE_TOOL_COUNT;
            return DEVICE_TOOLS;
        }
        memcpy(merged, DEVICE_TOOLS, sizeof(aiterm_tool_t) * DEVICE_TOOL_COUNT);
        memcpy(merged + DEVICE_TOOL_COUNT, TIME_TOOLS, sizeof(aiterm_tool_t) * TIME_TOOL_COUNT);
    }
    *count = n;
    return merged;
}

// ── something came due ────────────────────────────────────────────────────
// The schedule's tick runs on the esp_timer task, which must not block, so the
// work happens on a short-lived task of its own.

static sched_entry_t s_firing;
static volatile bool s_ringing;

static void alarm_task(void *arg)
{
    if (s_firing.prompt[0]) {
        // A scheduled prompt answers itself. The reply arriving is the point, so it
        // chirps once rather than ringing — nobody needs an alarm to read a weather
        // report they asked for yesterday.
        sounds_cue("chime");
        ui_prompt(s_firing.prompt, "device");
        aiterm_ws_chat(s_firing.prompt);
    } else {
        char detail[40];
        sched_describe(&s_firing, detail, sizeof(detail));
        // An alarm outranks a film. Without this the player still owns the panel,
        // ui_push refuses, and the alarm rings for a minute with nothing on screen
        // and no way to dismiss it.
        if (video_player_active()) video_player_stop("an alarm went off");
        shell_alarm_show(s_firing.label, detail);
        // Rings until dismissed, or for a minute. sounds_play rather than
        // sounds_cue on purpose: an alarm is the one sound that should still go off
        // when ui sounds have been turned off.
        const int64_t until = esp_timer_get_time() + 60LL * 1000 * 1000;
        while (s_ringing && shell_alarm_active() && esp_timer_get_time() < until) {
            sounds_play("alarm", -1);
            vTaskDelay(pdMS_TO_TICKS(500));
        }
        shell_alarm_dismiss();
    }
    s_ringing = false;
    vTaskDelete(NULL);
}

static void on_schedule_fired(const sched_entry_t *e)
{
    // Posted whatever happens next, including for the alarm that is dropped below:
    // "one at a time" is a reason not to ring twice, not a reason to lose the
    // second one entirely.
    if (e->prompt[0]) {
        notify_post("asked", e->prompt);
    } else if (e->kind == SCHED_TIMER) {
        // Not sched_describe: a timer that has just gone off describes itself as
        // "0:00 left", which is true and useless.
        notify_post(e->label[0] ? e->label : "timer", "the timer finished");
    } else {
        char detail[40];
        sched_describe(e, detail, sizeof(detail));
        notify_post(e->label[0] ? e->label : "alarm", detail);
    }

    if (s_ringing) return; // one at a time; a second alarm waits for the first
    s_firing = *e;
    s_ringing = true;
    if (xTaskCreate(alarm_task, "alarm", 4096, NULL, 4, NULL) != pdPASS) s_ringing = false;
}

static void on_time(int64_t utc, const char *tz, void *ctx)
{
    if (tz) aiclock_set_tz(tz);
    aiclock_set_from_server((time_t)utc);
}

// The names of the saved networks, so the dashboard can show and edit the list.
// Passwords stay on the device.
static void report_wifi(void)
{
    if (!aiterm_ws_connected()) return;
    const char *ssids[WIFI_STORE_MAX];
    int n = 0;
    for (int i = 0; i < wifi_store_count() && n < WIFI_STORE_MAX; i++) {
        const wifi_saved_t *e = wifi_store_at(i);
        if (e) ssids[n++] = e->ssid;
    }
    aiterm_ws_wifi_networks(ssids, n, net_wifi_state() == NET_WIFI_CONNECTED ? net_wifi_ssid() : "");
}

static void on_wifi_add(const char *ssid, const char *password, void *ctx)
{
    if (!ssid || !*ssid) return;
    if (wifi_store_add(ssid, password) == ESP_OK) {
        ESP_LOGI(TAG, "\"%s\" added from the dashboard", ssid);
        notify_post("wi-fi", ssid);
        net_wifi_retry_now(); // no-op while a link is up, which is the policy
    } else {
        ESP_LOGW(TAG, "no room to save \"%s\"", ssid);
    }
    report_wifi();
}

static void on_wifi_forget(const char *ssid, void *ctx)
{
    if (wifi_store_forget(ssid)) ESP_LOGI(TAG, "\"%s\" forgotten from the dashboard", ssid);
    report_wifi();
}

// Tells the server what this device's settings actually are. Sent on connect and
// again whenever one is committed, from whichever side changed it, so the dashboard
// shows the hardware rather than the last thing it asked for.
static void report_settings(void)
{
    if (!aiterm_ws_connected()) return;
    cJSON *obj = cJSON_CreateObject();
    if (!obj) return;
    settings_to_json(obj);
    aiterm_ws_settings(obj);
}

// ── server session, shown on the LED, the panel and the serial monitor ────

static void on_state(aiterm_state_t state, void *ctx)
{
    switch (state) {
    case AITERM_CONNECTED:
        ESP_LOGI(TAG, "linked to the AI-TERM server");
        tools_led_idle();
        ui_link("linked", s_ip);
        report_settings();
        report_wifi();
        break;
    case AITERM_WORKING:
        tools_led_status(40, 20, 0); // amber while the agent works
        break;
    case AITERM_IDLE:
        tools_led_idle();
        break;
    case AITERM_DISCONNECTED:
        tools_led_status(24, 12, 0);
        ui_link("reconnecting", s_ip);
        break;
    case AITERM_FAILED:
        tools_led_status(48, 0, 0);
        ui_link("failed", s_ip);
        break;
    }
}

static void on_prompt(const char *text, const char *origin, void *ctx)
{
    printf("\n[%s] > %s\nterm > ", origin, text);
    fflush(stdout);
    ui_prompt(text, origin);
}

static void on_chat_delta(const char *text, void *ctx)
{
    printf("%s", text);
    fflush(stdout);
    ui_reply_append(text);
}

static void on_chat_done(int input_tokens, int output_tokens, bool aborted, void *ctx)
{
    printf("\n      [%s%d in / %d out]\n> ", aborted ? "aborted · " : "", input_tokens, output_tokens);
    fflush(stdout);
    ui_reply_done(aborted, input_tokens, output_tokens);
}

// Relabels the splash the mic press put up: "running agent", then each tool by name.
// The server decides the wording, so it can change without a reflash.
static void on_stage(const char *label, const char *detail, void *ctx)
{
    (void)ctx;
    ui_stage(label, detail);
}

static void on_notice(const char *msg, void *ctx)
{
    printf("\n-- %s\n> ", msg);
    fflush(stdout);
    // Kept as well as flashed. Four seconds on the panel is right for an aside, but
    // it used to be the only place it ever appeared: look away and it was gone.
    notify_post("notice", msg);
    ui_notice(msg);
}

static void on_error(const char *msg, void *ctx)
{
    printf("\n!! %s\n> ", msg);
    fflush(stdout);
    ui_error(msg);
}

// Settings pushed from the dashboard (device → config tab), applied live.
static void on_config(const cJSON *config, void *ctx)
{
    settings_from_json(config);
}

// The agent found a picture; the server cropped and scaled it for this panel.
static void on_image(const uint8_t *jpeg, size_t len, void *ctx)
{
    if (!ui_raw_image(jpeg, len)) ESP_LOGW(TAG, "a %u byte image would not decode", (unsigned)len);
}

// The dashboard asked for a clip; the recorder streams it up on its own task.
static void on_record(const char *clip_id, int seconds, void *ctx)
{
    esp_err_t err = recorder_start(clip_id, seconds, 0, "web", false, NULL, NULL);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "record request refused: %s", esp_err_to_name(err));
        return;
    }
    ui_listening(seconds);
}

// ── the mic button: three gestures ────────────────────────────────────────
// Hold      speak a question. The clip goes up flagged as a prompt and the server
//           transcribes it and answers, so the loop needs no keyboard.
// Double tap start a hands-free voice note: keep recording until told to stop.
// Single tap stop the note.
//
// They do not collide because a hold never reaches the tap counter, and a tap did
// nothing at all before — it was already thrown away as too short to be speech.

static char s_ptt_clip[48];
static char s_note_clip[48];
static char s_video_id[40]; // the stream the transport keys act on
static bool s_note_recording;
static int64_t s_last_tap_us;
// Set when a mic press was spent stopping an alarm, so its release does nothing.
static bool s_stopped_alarm;

// Measured release-to-release, so it has to cover the gap between the taps *and*
// the second tap itself. 450 ms was too tight to hit reliably.
#define DOUBLE_TAP_US (650 * 1000)

// Played once the clip is on its way, from the recorder's own task.
// Back was pressed during a recording. Throwing the clip away was the point, so the
// failure that follows it is not one worth showing an error screen for.
static bool s_rec_cancelled;

static void on_talk_done(bool ok, const char *summary, void *ctx)
{
    if (s_rec_cancelled) {
        s_rec_cancelled = false;
        sounds_cue("tick");
        ui_notice("cancelled");
        return;
    }
    sounds_cue(ok ? "tick" : "error");
    if (!ok) ESP_LOGW(TAG, "push-to-talk: %s", summary);
}

// How long the note ran, measured when it was stopped rather than when the upload
// finished — the upload is not part of the recording.
static float s_note_seconds;
static int64_t s_note_started_us;

// Back during a recording means "up one level", and up one level from recording is
// not recording. Registered with ui_on_cancel, so it runs on the render task.
static void cancel_recording(void)
{
    if (!recorder_active()) return;
    s_rec_cancelled = true;
    recorder_stop(true); // aborted: nothing is uploaded and nothing is kept
    ESP_LOGI(TAG, "recording cancelled");
}

// Played from the recorder's own task once the note has gone up.
static void on_note_done(bool ok, const char *summary, void *ctx)
{
    s_note_recording = false;
    if (s_rec_cancelled) {
        s_rec_cancelled = false;
        sounds_cue("tick");
        ui_notice("cancelled");
        return;
    }
    sounds_cue(ok ? "done" : "error");
    if (!ok) {
        ESP_LOGW(TAG, "voice note: %s", summary);
        ui_error("the voice note was not saved");
        return;
    }
    ESP_LOGI(TAG, "voice note: %s", summary);
    // A notice, not the sending screen: nothing is being transcribed — a note is
    // kept to listen to, not answered — and the panel should say what happened and
    // then get out of the way. Back dismisses it at once.
    char msg[48];
    snprintf(msg, sizeof(msg), "saved: %.1fs", (double)s_note_seconds);
    ui_notice(msg);
}

// The second tap of a double tap arrives while the *first* tap's push-to-talk
// recording is still being torn down — the recorder does not let go of its
// semaphore until it has stopped the mic and sent audio.end, which is a network
// round trip. Giving up at that point is what made the gesture look broken: the
// second tap did nothing at all. So the start is deferred until the recorder is
// actually free, rather than abandoned.
static esp_timer_handle_t s_note_retry;
static int s_note_retries;

static void start_voice_note(void);

// One place to end a note, so the button and the console both time it the same way.
static void stop_voice_note(void)
{
    if (!s_note_recording) return;
    s_note_seconds = (float)(esp_timer_get_time() - s_note_started_us) / 1000000.0f;
    recorder_stop(false);
}

static void note_retry_cb(void *arg)
{
    if (recorder_active()) {
        // Bounded, and it gives up rather than calling back into start_voice_note,
        // which would just schedule another retry and spin for ever.
        if (s_note_retries++ < 30) esp_timer_start_once(s_note_retry, 50 * 1000); // up to ~1.5 s
        else ESP_LOGW(TAG, "the recorder never freed up; the voice note was dropped");
        return;
    }
    start_voice_note();
}

static void start_voice_note(void)
{
    if (!bsp_mic_available() || !aiterm_ws_connected()) {
        ui_error("cannot record a note right now");
        return;
    }
    if (recorder_active()) {
        if (!s_note_retry) {
            const esp_timer_create_args_t args = {
                .callback = note_retry_cb,
                .arg = NULL,
                .dispatch_method = ESP_TIMER_TASK,
                .name = "note_retry",
                .skip_unhandled_events = true,
            };
            if (esp_timer_create(&args, &s_note_retry) != ESP_OK) return;
        }
        s_note_retries = 0;
        esp_timer_start_once(s_note_retry, 50 * 1000);
        return;
    }

    sounds_cue("ok"); // before the microphone opens, or the note starts with a beep
    recorder_id(s_note_clip, sizeof(s_note_clip));
    if (recorder_start(s_note_clip, 0, RECORDER_MAX_NOTE_SECONDS, "note", false, on_note_done, NULL) == ESP_OK) {
        s_note_recording = true;
        s_note_started_us = esp_timer_get_time();
        ui_listening(0); // the panel counts up and shows the level
        ESP_LOGI(TAG, "recording a voice note; tap to stop");
    }
}

static void on_talk_press(void *ctx)
{
    ui_note_activity(); // the mic button wakes a dark panel too, and still records

    // A ringing alarm takes the panel and any key stops it — and the mic button is
    // the biggest button on the box, so pressing it means stop as well. Without this
    // the recording's own screen covered the ring screen while the alarm task kept
    // sounding for its full minute: the alarm looked dismissed and was not.
    //
    // Injected rather than calling shell_alarm_dismiss() from this task, so the stop
    // stays in the ring screen's own input handler, where `ringing` and the screen
    // stack are cleared together and cannot drift apart.
    if (shell_alarm_active()) {
        s_stopped_alarm = true; // so the release does not also count this as a tap
        bsp_keys_inject(BSP_KEY_BACK);
        return;
    }

    // A press while a note is running ends it. Acting on the press rather than the
    // release makes the stop feel immediate, and the release then has nothing to do.
    if (s_note_recording) {
        stop_voice_note();
        return;
    }
    if (!bsp_mic_available()) {
        ui_error("no microphone is fitted");
        return;
    }
    if (!aiterm_ws_connected()) {
        ui_error("not linked to the server yet");
        return;
    }
    if (recorder_active()) return;

    // A press hard on the heels of the last tap is almost certainly the second of a
    // double tap. Opening a push-to-talk recording for it would only be thrown away
    // again on release — and its teardown is the very thing the voice note would
    // then have to wait for. So leave the microphone alone and let the release
    // decide what the gesture was.
    if (s_last_tap_us && esp_timer_get_time() - s_last_tap_us < DOUBLE_TAP_US) return;

    // The cue plays first: start the microphone before it and the clip opens with
    // the terminal beeping at itself.
    sounds_cue("listening");

    recorder_id(s_ptt_clip, sizeof(s_ptt_clip));
    if (recorder_start(s_ptt_clip, 0, 0, "mic", true, on_talk_done, NULL) == ESP_OK) {
        ui_listening(0); // open-ended: the panel counts up instead of down
    }
}

static void on_talk_release(void *ctx, int held_ms)
{
    if (s_stopped_alarm) {
        // The press stopped an alarm. Falling through would record this as a mic tap,
        // and a second alarm stopped the same way would read as the double tap that
        // starts a voice note.
        s_stopped_alarm = false;
        s_last_tap_us = 0;
        return;
    }
    if (s_note_recording) return; // the press already stopped it

    const int64_t now = esp_timer_get_time();
    const bool second_tap = s_last_tap_us && now - s_last_tap_us < DOUBLE_TAP_US;

    if (recorder_active()) {
        // A knock rather than a question: bin it instead of sending a fragment.
        const bool too_short = held_ms < BOARD_BUTTON_MIN_MS;
        recorder_stop(too_short);
        if (!too_short) {
            ui_sending(); // on_talk_done chirps once the clip has actually gone
            s_last_tap_us = 0;
            return;
        }
    } else if (held_ms >= BOARD_BUTTON_MIN_MS) {
        // Held, but nothing was recording — no microphone, or no link. The press
        // already said so; there is no tap to count here.
        return;
    }

    // Too short to be speech, so it counts as a tap instead. Two in quick
    // succession is the gesture for a voice note.
    if (second_tap) {
        s_last_tap_us = 0;
        start_voice_note();
    } else {
        s_last_tap_us = now;
        ESP_LOGI(TAG, "mic tap (%d ms); tap again to start a voice note", held_ms);
    }
}

// ── navigation keys ───────────────────────────────────────────────────────
// The shell drains the queue itself; this only logs, which is how the wiring is
// checked without opening anything.

static void on_key(bsp_key_t key, bool down, void *ctx)
{
    ui_note_activity(); // any key wakes a dimmed panel, whatever it goes on to do
    if (!down) return;
    ESP_LOGI(TAG, "key: %s", bsp_key_name(key));

    // While a video owns the glass the keys are transport controls. The compositor
    // will not open anything over it, so these are the only thing the keys could
    // usefully do, and back is the way out.
    if (!video_player_active()) return;
    switch (key) {
    case BSP_KEY_BACK:
        video_player_stop("back key");
        break;
    case BSP_KEY_OK:
        // Asked for rather than done here: the server has to stop pushing frames
        // too, or its queues fill while the device sits still.
        aiterm_ws_video_control(s_video_id, video_player_paused() ? "resume" : "pause");
        break;
    case BSP_KEY_LEFT:
        aiterm_ws_video_control(s_video_id, "seek_back");
        break;
    case BSP_KEY_RIGHT:
        aiterm_ws_video_control(s_video_id, "seek_fwd");
        break;
    default:
        break;
    }
}

// ── settings, from the console ────────────────────────────────────────────
// "/set" lists them, "/set <key> <value>" changes one. The panel gets a settings
// screen too, but this works with no screen, over a cable, and is what a headless
// board or a bench test has to use.

static void console_settings(const char *arg)
{
    char key[32] = "";
    int value = 0;
    const int parsed = sscanf(arg, "%31s %d", key, &value);

    if (parsed < 1) {
        printf("settings:\n");
        for (int i = 0; i < SET_COUNT; i++) {
            const setting_spec_t *sp = settings_spec((setting_id_t)i);
            printf("  %-20s %4d%-2s  (%d..%d)\n", sp->json_key, settings_get((setting_id_t)i), sp->unit,
                   sp->min, sp->max);
        }
        printf("  /set <key> <value>\n");
        return;
    }
    for (int i = 0; i < SET_COUNT; i++) {
        const setting_spec_t *sp = settings_spec((setting_id_t)i);
        if (strcmp(sp->json_key, key) != 0) continue;
        if (parsed < 2) {
            printf("%s = %d%s\n", sp->json_key, settings_get((setting_id_t)i), sp->unit);
            return;
        }
        settings_set((setting_id_t)i, value);
        printf("%s = %d%s\n", sp->json_key, settings_get((setting_id_t)i), sp->unit);
        return;
    }
    printf("!! no setting called \"%s\"\n", key);
}

// ── phase 0 bench (temporary) ─────────────────────────────────────────────
// Typed at the console: /bench runs the render-path timings, /soak N hammers the
// panel to expose corruption at a higher SPI clock.

extern const uint8_t flat_start[] asm("_binary_flat_jpg_start");
extern const uint8_t flat_end[] asm("_binary_flat_jpg_end");
extern const uint8_t photo_start[] asm("_binary_photo_jpg_start");
extern const uint8_t photo_end[] asm("_binary_photo_jpg_end");
extern const uint8_t noise_start[] asm("_binary_noise_jpg_start");
extern const uint8_t noise_end[] asm("_binary_noise_jpg_end");
extern const uint8_t q12_start[] asm("_binary_photo_q12_jpg_start");
extern const uint8_t q12_end[] asm("_binary_photo_q12_jpg_end");
extern const uint8_t q20_start[] asm("_binary_photo_q20_jpg_start");
extern const uint8_t q20_end[] asm("_binary_photo_q20_jpg_end");

static void run_bench(void)
{
    const bsp_bench_image_t images[] = {
        {"flat colour", flat_start, (size_t)(flat_end - flat_start)},
        {"photo", photo_start, (size_t)(photo_end - photo_start)},
        {"photo q12 (lower quality)", q12_start, (size_t)(q12_end - q12_start)},
        {"photo q20 (lowest quality)", q20_start, (size_t)(q20_end - q20_start)},
        {"noise (worst case)", noise_start, (size_t)(noise_end - noise_start)},
    };
    bsp_display_bench(images, sizeof(images) / sizeof(images[0]), 40);
}

// ── video ─────────────────────────────────────────────────────────────────
// The server does the fetching and transcoding; the device decodes, presents and
// keeps time. Everything here just forwards to the player.

static void on_video_start(const char *id, int w, int h, int fps, int audio_rate, void *ctx)
{
    strlcpy(s_video_id, id ? id : "", sizeof(s_video_id));
    video_player_start(id, w, h, fps, audio_rate);
}

static void on_video_frame(const uint8_t *jpeg, size_t len, uint32_t pts_ms, void *ctx)
{
    video_player_frame(jpeg, len, pts_ms);
}

static void on_video_audio(const int16_t *pcm, size_t samples, uint32_t pts_ms, void *ctx)
{
    video_player_audio(pcm, samples, pts_ms);
}

static void on_video_stop(const char *id, const char *reason, void *ctx)
{
    video_player_stop(reason);
}

// ── voice notes ───────────────────────────────────────────────────────────
// Straight through to the player; it owns the ring, the speaker and the credit.

static void on_notes(const char *id, float seconds, const char *at, bool last, void *ctx)
{
    notes_on_list(id, seconds, at, last);
}

static void on_note_start(const char *id, int rate, float seconds, int from_ms, void *ctx)
{
    notes_on_start(id, rate, seconds, from_ms);
}

static void on_note_audio(const uint8_t *pcm, size_t bytes, uint32_t pts_ms, void *ctx)
{
    notes_on_audio(pcm, bytes, pts_ms);
}

static void on_note_seek(int from_ms, void *ctx)
{
    notes_on_seek(from_ms);
}

static void on_note_end(const char *reason, void *ctx)
{
    notes_on_end(reason);
}

static void on_video_pause(bool paused, void *ctx)
{
    video_player_pause(paused);
}

static void on_video_flush(void *ctx)
{
    video_player_flush();
}

// Type a prompt in `idf.py monitor` and press enter.
static void console_task(void *arg)
{
    usb_serial_jtag_driver_config_t usb_cfg = {
        .rx_buffer_size = 256,
        .tx_buffer_size = 256,
    };
    if (usb_serial_jtag_driver_install(&usb_cfg) != ESP_OK) {
        ESP_LOGW(TAG, "no console input available");
        vTaskDelete(NULL);
        return;
    }

    char line[256];
    size_t len = 0;
    while (true) {
        uint8_t ch;
        if (usb_serial_jtag_read_bytes(&ch, 1, pdMS_TO_TICKS(100)) != 1) continue;
        if (ch == '\r' || ch == '\n') {
            printf("\n");
            line[len] = '\0';
            if (len > 0) {
                if (strcmp(line, "/bench") == 0) {
                    run_bench();
                } else if (strncmp(line, "/soak", 5) == 0) {
                    bsp_display_soak(atoi(line + 5) > 0 ? atoi(line + 5) : 30);
                } else if (strncmp(line, "/set", 4) == 0 && (line[4] == '\0' || line[4] == ' ')) {
                    console_settings(line[4] ? line + 5 : "");
                } else if (strncmp(line, "/v ", 3) == 0) {
                    // The transport keys, for a board being driven over a cable:
                    // /v pause | resume | seek_back | seek_fwd
                    if (!video_player_active()) {
                        printf("!! nothing is playing\n");
                    } else {
                        aiterm_ws_video_control(s_video_id, line + 3);
                        printf("sent %s\n", line + 3);
                    }
                } else if (strcmp(line, "/time") == 0) {
                    char now[32], date[32];
                    aiclock_time_ampm(now, sizeof(now), true);
                    aiclock_date_str(date, sizeof(date));
                    printf("%s %s  tz %s  (%s)\n", date, now, aiclock_tz(),
                           aiclock_synced() ? "sntp" : (aiclock_ready() ? "from the server" : "not set"));
                    for (int i = 0; i < sched_count(); i++) {
                        const sched_entry_t *e = sched_at(i);
                        char when[48];
                        sched_describe(e, when, sizeof(when));
                        printf("  #%u %-5s %-18s %s%s\n", (unsigned)e->id,
                               e->kind == SCHED_TIMER ? "timer" : "alarm", when, e->label,
                               e->enabled ? "" : " (off)");
                    }
                    if (!sched_count()) printf("  nothing scheduled\n");
                } else if (strncmp(line, "/cancel ", 8) == 0) {
                    const uint32_t id = (uint32_t)atoi(line + 8);
                    printf(sched_cancel(id) ? "cancelled #%u\n" : "nothing with id #%u\n", (unsigned)id);
                } else if (strncmp(line, "/pomo", 5) == 0) {
                    if (strstr(line, "start")) shell_pomodoro_start();
                    else if (strstr(line, "skip")) shell_pomodoro_skip();
                    else if (strstr(line, "stop")) shell_pomodoro_stop();
                    char state[64];
                    shell_pomodoro_status(state, sizeof(state));
                    printf("pomodoro: %s\n", state);
                } else if (strncmp(line, "/todo", 5) == 0) {
                    // /todo                  list them
                    // /todo add <text>       one for the "todos" list
                    // /todo daily <text>     one that comes back every day
                    // /todo ok <n>           tick or untick
                    // /todo del <n>          delete
                    const char *a = line + 5;
                    while (*a == ' ') a++;
                    if (strncmp(a, "add ", 4) == 0) {
                        printf(shell_todo_add(a + 4, false) ? "added\n" : "the list is full\n");
                    } else if (strncmp(a, "daily ", 6) == 0) {
                        printf(shell_todo_add(a + 6, true) ? "added, daily\n" : "the list is full\n");
                    } else if (strncmp(a, "ok ", 3) == 0) {
                        printf(shell_todo_toggle_at(atoi(a + 3)) ? "toggled\n" : "no todo at that index\n");
                    } else if (strncmp(a, "del ", 4) == 0) {
                        printf(shell_todo_delete_at(atoi(a + 4)) ? "deleted\n" : "no todo at that index\n");
                    }
                    const int total = shell_todo_total();
                    for (int i = 0; i < total; i++) {
                        char row[64];
                        shell_todo_describe(i, row, sizeof(row));
                        printf("  %d  %s\n", i, row);
                    }
                    if (!total) printf("  no todos\n");
                } else if (strncmp(line, "/timer ", 7) == 0) {
                    const uint32_t id = sched_add_timer(atoi(line + 7), "console", NULL);
                    printf(id ? "timer #%u set\n" : "could not set a timer\n", (unsigned)id);
                } else if (strncmp(line, "/key ", 5) == 0) {
                    // Drives the interface over the cable: /key up|down|left|right|ok|back
                    const char *want = line + 5;
                    int found = -1;
                    for (int k = 0; k < BSP_KEY_COUNT; k++) {
                        if (strcmp(bsp_key_name((bsp_key_t)k), want) == 0) found = k;
                    }
                    if (found < 0) {
                        printf("!! no key called \"%s\"\n", want);
                    } else {
                        bsp_keys_inject((bsp_key_t)found);
                        printf("tapped %s\n", want);
                    }
                } else if (strncmp(line, "/press ", 7) == 0) {
                    // Like /key, but through the wire: it pulls the pin down, so the
                    // interrupt, the debounce and the queue all have to work. /key
                    // only puts an event on the queue and would pass even if the
                    // hardware path were completely broken.
                    const char *want = line + 7;
                    int found = -1;
                    for (int k = 0; k < BSP_KEY_COUNT; k++) {
                        if (strcmp(bsp_key_name((bsp_key_t)k), want) == 0) found = k;
                    }
                    if (found < 0) printf("!! no key called \"%s\"\n", want);
                    else printf(bsp_keys_press_pin((bsp_key_t)found, 60) ? "pressed %s for real\n"
                                                                         : "could not press %s\n",
                                want);
                } else if (strncmp(line, "/tap", 4) == 0) {
                    // The mic button, over the cable: /tap [held_ms]. Two of these
                    // in quick succession is the voice-note gesture.
                    const int held = atoi(line + 4) > 0 ? atoi(line + 4) : 120;
                    bsp_button_inject(held);
                    printf("tapped the mic button for %d ms\n", held);
                } else if (strncmp(line, "/talk", 5) == 0) {
                    // What holding the mic button does, for a board on a cable. In a
                    // quiet room this is how the "nothing was said" path gets tested.
                    const int secs = atoi(line + 5) > 0 ? atoi(line + 5) : 2;
                    recorder_id(s_ptt_clip, sizeof(s_ptt_clip));
                    if (recorder_start(s_ptt_clip, secs, 0, "mic", true, on_talk_done, NULL) == ESP_OK) {
                        ui_listening(secs);
                        printf("listening for %ds, as a prompt\n", secs);
                    }
                } else if (strcmp(line, "/note") == 0) {
                    // The same voice note the mic button's double tap starts, for a
                    // board being driven over a cable.
                    if (s_note_recording) {
                        stop_voice_note();
                        printf("note stopped\n");
                    } else {
                        start_voice_note();
                        printf("recording a voice note; /note again to stop\n");
                    }
                } else if (strcmp(line, "/menu") == 0) {
                    ui_go_home();
                    printf("menu open; the back key closes it\n");
                } else if (strcmp(line, "/power") == 0) {
                    // Whatever is holding the chip awake, by name. The failure mode
                    // for light sleep is not an error, it is silently never
                    // happening, and this is the only thing that shows the
                    // difference.
                    printf("power saving %s; %s\n", settings_get(SET_POWER_SAVE) ? "on" : "off",
                           bsp_power_sleep_allowed() ? "80-240 MHz, light sleep allowed"
                                                     : "pinned at 240 MHz, no sleep");
                    printf("locks held right now:\n");
                    esp_pm_dump_locks(stdout);
                } else if (strcmp(line, "/screen") == 0) {
                    printf("screen: %s (depth %d), backlight %d%%, led %s, notifications %d/%d unread\n",
                           ui_screen(), ui_depth(), bsp_display_backlight_get(),
                           bsp_status_led_blanked() ? "blanked" : "live", notify_unread(), notify_count());
                } else if (strcmp(line, "/new") == 0) {
                    aiterm_ws_new_session();
                } else if (strcmp(line, "/abort") == 0) {
                    aiterm_ws_abort();
                } else if (!aiterm_ws_connected()) {
                    printf("!! not connected to the server yet\n");
                } else if (aiterm_ws_chat(line) == ESP_OK) {
                    // The server only echoes chat.user back for prompts from the
                    // dashboard, on the grounds that we already know what we typed —
                    // so the panel has to be told here, or it keeps the last answer up
                    // until the first chunk of the new one arrives.
                    ui_prompt(line, "device");
                    printf("term > ");
                }
            }
            len = 0;
            fflush(stdout);
            continue;
        }
        if ((ch == '\b' || ch == 127) && len > 0) {
            len--;
            printf("\b \b");
            fflush(stdout);
            continue;
        }
        if (len < sizeof(line) - 1 && ch >= ' ') {
            line[len++] = (char)ch;
            printf("%c", ch);
            fflush(stdout);
        }
    }
}

void app_main(void)
{
    // Before any peripheral: NVS holds the settings, and the settings decide what
    // the peripherals should come up at. Starting at full brightness and correcting
    // to 30% a second later is a visible flash on every boot.
    init_nvs();
    settings_init();
    aiclock_init();
    sounds_init();
    notes_init();

    const bsp_config_t bsp_cfg = {
        .status_led_gpio = BOARD_STATUS_LED_GPIO,
    };
    ESP_ERROR_CHECK(bsp_init(&bsp_cfg));
    bsp_log_chip_info();

    const bsp_display_config_t lcd_cfg = {
        .sclk_gpio = BOARD_LCD_SCLK_GPIO,
        .mosi_gpio = BOARD_LCD_MOSI_GPIO,
        .rst_gpio = BOARD_LCD_RST_GPIO,
        .dc_gpio = BOARD_LCD_DC_GPIO,
        .cs_gpio = BOARD_LCD_CS_GPIO,
        .bl_gpio = BOARD_LCD_BL_GPIO,
        .brightness = settings_get(SET_DISPLAY_BRIGHTNESS),
        .width = BOARD_LCD_WIDTH,
        .height = BOARD_LCD_HEIGHT,
        .hz = BOARD_LCD_HZ,
        .spi_mode = BOARD_LCD_SPI_MODE,
        .invert = BOARD_LCD_INVERT,
        .rgb_order = BOARD_LCD_RGB_ORDER,
        .x_gap = BOARD_LCD_X_GAP,
        .y_gap = BOARD_LCD_Y_GAP,
    };
#if BOARD_LCD_PINWALK
    bsp_display_pinwalk(&lcd_cfg);
#endif
    const esp_err_t lcd_err = bsp_display_init(&lcd_cfg);
    if (lcd_err != ESP_OK) {
        ESP_LOGW(TAG, "display not available (%s); the panel is disabled", esp_err_to_name(lcd_err));
    } else {
#if BOARD_LCD_SELFTEST
        bsp_display_selftest();
#endif
        ui_start();
        ui_boot("starting");
    }

    const bsp_mic_config_t mic_cfg = {
        .bclk_gpio = BOARD_MIC_BCLK_GPIO,
        .ws_gpio = BOARD_MIC_WS_GPIO,
        .din_gpio = BOARD_MIC_DIN_GPIO,
        .sample_rate = 16000,
        .gain_shift = settings_get(SET_MIC_GAIN_SHIFT),
    };
    if (bsp_mic_init(&mic_cfg) != ESP_OK) ESP_LOGW(TAG, "microphone not available; recording is disabled");

    const bsp_speaker_config_t spk_cfg = {
        .bclk_gpio = BOARD_SPK_BCLK_GPIO,
        .ws_gpio = BOARD_SPK_WS_GPIO,
        .dout_gpio = BOARD_SPK_DOUT_GPIO,
        .sd_gpio = BOARD_SPK_SD_GPIO,
        .sample_rate = BOARD_SPK_RATE,
    };
    // Volume is not set here: settings_apply_all() below does it, along with
    // everything else, so there is one place that pushes settings to hardware.
    if (bsp_speaker_init(&spk_cfg) != ESP_OK) ESP_LOGW(TAG, "speaker not available; the terminal will stay quiet");

    const bsp_button_config_t talk_cfg = {
        .gpio = BOARD_BUTTON_GPIO,
        .active_low = BOARD_BUTTON_ACTIVE_LOW,
        .on_press = on_talk_press,
        .on_release = on_talk_release,
    };
    if (bsp_button_init(&talk_cfg) != ESP_OK) ESP_LOGW(TAG, "push-to-talk button not available");

    const bsp_keys_config_t keys_cfg = {
        .gpio = {
            [BSP_KEY_UP] = BOARD_KEY_UP_GPIO,
            [BSP_KEY_DOWN] = BOARD_KEY_DOWN_GPIO,
            [BSP_KEY_LEFT] = BOARD_KEY_LEFT_GPIO,
            [BSP_KEY_RIGHT] = BOARD_KEY_RIGHT_GPIO,
            [BSP_KEY_OK] = BOARD_KEY_OK_GPIO,
            [BSP_KEY_BACK] = BOARD_KEY_BACK_GPIO,
        },
        .active_low = BOARD_KEYS_ACTIVE_LOW,
        .on_key = on_key,
    };
    if (bsp_keys_init(&keys_cfg) != ESP_OK) ESP_LOGW(TAG, "navigation keys not available");

    // Before settings_apply_all, which is what switches it on if it is on. Off
    // until then, so the console is alive through the whole of boot regardless.
    ESP_ERROR_CHECK(bsp_power_init());
    settings_apply_all();
    notify_init(); // before shell_init, which registers the drawer that reads it
    shell_init(); // the launcher becomes what the back key opens from the terminal
    ui_on_cancel(cancel_recording); // back throws a recording away
    settings_on_commit(report_settings);
    sched_on_fire(on_schedule_fired);
    sched_init();

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    // wifi_credentials.h is a seed now, not the source of truth. On a first flash it
    // puts the compiled-in network into the store so the device behaves exactly as it
    // always did; after that the saved list is what matters and the header is ignored.
    ESP_ERROR_CHECK(wifi_store_init());
    if (wifi_store_count() == 0 && WIFI_SSID[0]) {
        wifi_store_add(WIFI_SSID, WIFI_PASSWORD);
        ESP_LOGI(TAG, "seeded the network list from wifi_credentials.h");
    }

    const net_wifi_config_t wifi_cfg = {
        .hostname = AITERM_HOSTNAME,
        .cb = on_wifi_state,
    };
    if (net_wifi_start(&wifi_cfg) != ESP_OK) {
        tools_led_status(24, 0, 0);
        ui_error("the radio would not start");
        return;
    }
    // No network saved is no longer fatal. It used to return from app_main, which
    // also killed the console and the shell — so the one state that needs the panel
    // to fix it was the one state with no way to fix it.
    ESP_ERROR_CHECK(net_mdns_start(AITERM_HOSTNAME, "ESP32 AI Terminal"));
    ui_boot("announcing mdns");

    if (!net_wifi_wait_connected(pdMS_TO_TICKS(30000))) {
        ESP_LOGW(TAG, "no network yet; the link will come up once wifi connects");
    }

    size_t tool_count = 0;
    const aiterm_ws_config_t ws_cfg = {
        .uri = AITERM_SERVER_URI,
        .token = AITERM_DEVICE_TOKEN,
        .fw = AITERM_FIRMWARE,
        .access_level = AITERM_ACCESS_LEVEL,
        .remote_approval = AITERM_REMOTE_APPROVAL,
        .tools = all_tools(&tool_count),
        .tool_count = tool_count,
        .on_state = on_state,
        .on_prompt = on_prompt,
        .on_chat_delta = on_chat_delta,
        .on_chat_done = on_chat_done,
        .on_error = on_error,
        .on_notice = on_notice,
        .on_stage = on_stage,
        .on_wifi_add = on_wifi_add,
        .on_wifi_forget = on_wifi_forget,
        .on_record = on_record,
        .on_image = on_image,
        .on_video_start = on_video_start,
        .on_video_frame = on_video_frame,
        .on_video_audio = on_video_audio,
        .on_video_stop = on_video_stop,
        .on_video_pause = on_video_pause,
        .on_video_flush = on_video_flush,
        .on_notes = on_notes,
        .on_note_start = on_note_start,
        .on_note_audio = on_note_audio,
        .on_note_seek = on_note_seek,
        .on_note_end = on_note_end,
        .on_config = on_config,
        .on_time = on_time,
    };
    ui_boot("linking up");
    if (aiterm_ws_start(&ws_cfg) != ESP_OK) {
        tools_led_status(48, 0, 0);
        ESP_LOGE(TAG, "could not start the server link");
        ui_error("cannot reach " AITERM_SERVER_URI);
        return;
    }

    xTaskCreate(console_task, "console", 4096, NULL, 4, NULL);
    ESP_LOGI(TAG, "ready — type a prompt here and press enter");
    sounds_cue("boot");
}
