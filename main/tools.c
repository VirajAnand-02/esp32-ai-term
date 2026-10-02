#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "lwip/ip4_addr.h"
#include "esp_netif.h"

#include "freertos/semphr.h"

#include "board_config.h"
#include "bsp.h"
#include "recorder.h"
#include "settings.h"
#include "sounds.h"
#include "ui.h"
#include "tools.h"

// What the agent can do on this terminal: the on-board RGB LED, the microphone,
// the 240x240 panel, the speaker, and a status report.

typedef struct {
    const char *name;
    uint8_t r, g, b;
} named_color_t;

static const named_color_t COLORS[] = {
    {"off", 0, 0, 0},       {"red", 60, 0, 0},      {"green", 0, 60, 0},    {"blue", 0, 0, 60},
    {"amber", 60, 30, 0},   {"yellow", 50, 50, 0},  {"orange", 60, 20, 0},  {"purple", 40, 0, 60},
    {"magenta", 60, 0, 40}, {"pink", 60, 20, 30},   {"cyan", 0, 50, 50},    {"white", 40, 40, 40},
};

// The colour the LED returns to when nothing else is happening.
// Dark. The indicator sitting lit green for hours is the one thing on this board
// that draws current for no reason — the panel already says whether the link is up.
// Activity and failures still light it, and led_set makes a colour stick.
static uint8_t s_idle[3] = {0, 0, 0}; // dim green: connected and idle

static bool parse_color(const cJSON *args, uint8_t rgb[3], char *err, size_t err_len)
{
    const cJSON *color = cJSON_GetObjectItemCaseSensitive(args, "color");
    if (!cJSON_IsString(color)) {
        snprintf(err, err_len, "give a colour name (%s, …) or a hex value like #ff8800", COLORS[1].name);
        return false;
    }
    const char *text = color->valuestring;

    if (text[0] == '#' || (strlen(text) == 6 && strspn(text, "0123456789abcdefABCDEF") == 6)) {
        unsigned r, g, b;
        if (sscanf(text[0] == '#' ? text + 1 : text, "%2x%2x%2x", &r, &g, &b) != 3) {
            snprintf(err, err_len, "\"%s\" is not a hex colour", text);
            return false;
        }
        // The LED is bright and close to the eye; scale it down.
        rgb[0] = r / 4;
        rgb[1] = g / 4;
        rgb[2] = b / 4;
        return true;
    }

    for (size_t i = 0; i < sizeof(COLORS) / sizeof(COLORS[0]); i++) {
        if (strcasecmp(text, COLORS[i].name) == 0) {
            rgb[0] = COLORS[i].r;
            rgb[1] = COLORS[i].g;
            rgb[2] = COLORS[i].b;
            return true;
        }
    }
    snprintf(err, err_len, "unknown colour \"%s\"", text);
    return false;
}

static void apply_brightness(const cJSON *args, uint8_t rgb[3])
{
    const cJSON *pct = cJSON_GetObjectItemCaseSensitive(args, "brightness");
    if (!cJSON_IsNumber(pct)) return;
    double scale = pct->valuedouble / 100.0;
    if (scale < 0) scale = 0;
    if (scale > 1) scale = 1;
    for (int i = 0; i < 3; i++) rgb[i] = (uint8_t)(rgb[i] * scale);
}

static bool tool_led_set(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len)
{
    uint8_t rgb[3];
    if (!parse_color(args, rgb, err, err_len)) return false;
    apply_brightness(args, rgb);
    memcpy(s_idle, rgb, sizeof(rgb));
    bsp_status_led_set(rgb[0], rgb[1], rgb[2]);
    snprintf(out, out_len, "LED is now %s (rgb %u,%u,%u)",
             cJSON_GetObjectItem(args, "color")->valuestring, rgb[0], rgb[1], rgb[2]);
    return true;
}

static bool tool_led_blink(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len)
{
    uint8_t rgb[3];
    if (!parse_color(args, rgb, err, err_len)) return false;
    apply_brightness(args, rgb);

    const cJSON *times_item = cJSON_GetObjectItemCaseSensitive(args, "times");
    const cJSON *gap_item = cJSON_GetObjectItemCaseSensitive(args, "interval_ms");
    int times = cJSON_IsNumber(times_item) ? (int)times_item->valuedouble : 3;
    int gap = cJSON_IsNumber(gap_item) ? (int)gap_item->valuedouble : 250;
    times = times < 1 ? 1 : (times > 20 ? 20 : times);
    gap = gap < 50 ? 50 : (gap > 2000 ? 2000 : gap);

    for (int i = 0; i < times; i++) {
        bsp_status_led_set(rgb[0], rgb[1], rgb[2]);
        vTaskDelay(pdMS_TO_TICKS(gap));
        bsp_status_led_set(0, 0, 0);
        vTaskDelay(pdMS_TO_TICKS(gap));
    }
    tools_led_idle();
    snprintf(out, out_len, "blinked %d× every %d ms", times, gap);
    return true;
}

static bool tool_device_status(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len)
{
    (void)args;
    (void)err;
    (void)err_len;

    char display_state[32] = "not fitted";
    if (bsp_display_available()) {
        snprintf(display_state, sizeof(display_state), "%dx%d, backlight %d%%", bsp_display_width(),
                 bsp_display_height(), bsp_display_backlight_get());
    }

    char speaker_state[40] = "not fitted";
    if (bsp_speaker_available()) {
        snprintf(speaker_state, sizeof(speaker_state), "volume %d%% @ %" PRIu32 " Hz", bsp_speaker_volume(),
                 bsp_speaker_sample_rate());
    }

    wifi_ap_record_t ap = {0};
    esp_wifi_sta_get_ap_info(&ap);
    esp_netif_ip_info_t ip = {0};
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (netif) esp_netif_get_ip_info(netif, &ip);

    snprintf(out, out_len,
             "uptime %llus\nheap free %u KB (min %u KB)\npsram free %u KB\nwifi \"%s\" rssi %d dBm\nip " IPSTR
             "\nfirmware %s\nled rgb %u,%u,%u at %d%%\nmic %s (gain shift %d)\ndisplay %s\ntalk button %s"
             "\nspeaker %s\nscreen %s%s"
             "\nsettings: brightness %d%%, led %d%%, volume %d%%, gain %d, sounds %s, dim %ds, blank %ds",
             esp_timer_get_time() / 1000000ULL,
             (unsigned)(esp_get_free_heap_size() / 1024),
             (unsigned)(esp_get_minimum_free_heap_size() / 1024),
             (unsigned)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) / 1024),
             (const char *)ap.ssid, ap.rssi, IP2STR(&ip.ip),
             esp_app_get_description()->version, s_idle[0], s_idle[1], s_idle[2],
             bsp_status_led_brightness_get(),
             bsp_mic_available() ? (recorder_active() ? "recording" : "ready") : "not fitted",
             bsp_mic_gain_shift(), display_state,
             bsp_button_down() ? "held down" : "up", speaker_state, ui_screen(),
             ui_is_held() ? " (held: reply text will not paint over it)" : "",
             settings_get(SET_DISPLAY_BRIGHTNESS), settings_get(SET_LED_BRIGHTNESS),
             settings_get(SET_VOLUME), settings_get(SET_MIC_GAIN_SHIFT),
             settings_get(SET_UI_SOUNDS) ? "on" : "off", settings_get(SET_DIM_AFTER_S),
             settings_get(SET_BLANK_AFTER_S));
    return true;
}

void tools_led_idle(void)
{
    bsp_status_led_set(s_idle[0], s_idle[1], s_idle[2]);
}

void tools_led_status(uint8_t r, uint8_t g, uint8_t b)
{
    bsp_status_led_set(r, g, b);
}

typedef struct {
    SemaphoreHandle_t done;
    bool ok;
    char summary[160];
} record_wait_t;

static void on_record_done(bool ok, const char *summary, void *ctx)
{
    record_wait_t *w = ctx;
    w->ok = ok;
    strlcpy(w->summary, summary, sizeof(w->summary));
    xSemaphoreGive(w->done);
}

// Blocks the tool worker until the clip has been uploaded, so the agent gets a real answer.
static bool tool_record_audio(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len)
{
    if (!bsp_mic_available()) {
        snprintf(err, err_len, "no microphone is fitted on this device");
        return false;
    }
    const cJSON *secs = cJSON_GetObjectItemCaseSensitive(args, "seconds");
    int seconds = cJSON_IsNumber(secs) ? (int)secs->valuedouble : 5;

    record_wait_t wait = {.done = xSemaphoreCreateBinary()};
    if (!wait.done) {
        snprintf(err, err_len, "out of memory");
        return false;
    }
    char clip_id[48];
    recorder_id(clip_id, sizeof(clip_id));

    bool ok = false;
    if (recorder_start(clip_id, seconds, 0, "agent", false, on_record_done, &wait) != ESP_OK) {
        snprintf(err, err_len, "the microphone is busy with another recording");
    } else if (xSemaphoreTake(wait.done, pdMS_TO_TICKS((seconds + 20) * 1000)) != pdTRUE) {
        snprintf(err, err_len, "the recording did not finish in time");
    } else if (wait.ok) {
        strlcpy(out, wait.summary, out_len);
        ok = true;
    } else {
        strlcpy(err, wait.summary, err_len);
    }
    vSemaphoreDelete(wait.done);
    return ok;
}

static ui_tone_t parse_tone(const cJSON *args, const char *key, ui_tone_t fallback)
{
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(args, key);
    if (!cJSON_IsString(item)) return fallback;
    const char *t = item->valuestring;
    if (strcasecmp(t, "amber") == 0) return UI_TONE_AMBER;
    if (strcasecmp(t, "green") == 0) return UI_TONE_GREEN;
    if (strcasecmp(t, "red") == 0) return UI_TONE_RED;
    if (strcasecmp(t, "blue") == 0) return UI_TONE_BLUE;
    if (strcasecmp(t, "dim") == 0) return UI_TONE_DIM;
    return fallback;
}

static bool require_display(char *err, size_t err_len)
{
    if (bsp_display_available()) return true;
    snprintf(err, err_len, "no display is fitted on this device");
    return false;
}

static bool tool_display_text(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len)
{
    if (!require_display(err, err_len)) return false;
    const cJSON *text = cJSON_GetObjectItemCaseSensitive(args, "text");
    if (!cJSON_IsString(text)) {
        snprintf(err, err_len, "give the text to show");
        return false;
    }
    const cJSON *title = cJSON_GetObjectItemCaseSensitive(args, "title");
    const cJSON *size = cJSON_GetObjectItemCaseSensitive(args, "size");
    const int scale = cJSON_IsNumber(size) ? (int)size->valuedouble : 1;

    ui_raw_message(cJSON_IsString(title) ? title->valuestring : NULL, text->valuestring,
                   parse_tone(args, "color", UI_TONE_AMBER), scale);
    snprintf(out, out_len, "showing %d characters on the 240x240 panel", (int)strlen(text->valuestring));
    return true;
}

static bool tool_display_fill(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len)
{
    if (!require_display(err, err_len)) return false;
    uint8_t rgb[3];
    if (!parse_color(args, rgb, err, err_len)) return false;
    // parse_color dims for the LED; the panel wants the colour as given.
    const cJSON *color = cJSON_GetObjectItemCaseSensitive(args, "color");
    unsigned r = rgb[0] * 4, g = rgb[1] * 4, b = rgb[2] * 4;
    if (r > 255) r = 255;
    if (g > 255) g = 255;
    if (b > 255) b = 255;

    ui_raw_fill((uint8_t)r, (uint8_t)g, (uint8_t)b);
    snprintf(out, out_len, "filled the panel with %s (rgb %u,%u,%u)", color->valuestring, r, g, b);
    return true;
}

static bool tool_display_pattern(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len)
{
    if (!require_display(err, err_len)) return false;
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(args, "pattern");
    const char *pattern = cJSON_IsString(item) ? item->valuestring : "bars";
    if (!ui_raw_pattern(pattern)) {
        snprintf(err, err_len, "pattern must be bars, grid or gradient");
        return false;
    }
    snprintf(out, out_len, "drew the %s test pattern; the panel is %dx%d", pattern, bsp_display_width(),
             bsp_display_height());
    return true;
}

static bool tool_display_backlight(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len)
{
    if (!require_display(err, err_len)) return false;
    if (bsp_display_backlight_get() < 0) {
        snprintf(err, err_len, "this panel's backlight is not switchable");
        return false;
    }
    const cJSON *pct = cJSON_GetObjectItemCaseSensitive(args, "percent");
    if (!cJSON_IsNumber(pct)) {
        snprintf(err, err_len, "give a brightness percentage from 0 to 100");
        return false;
    }
    bsp_display_backlight((int)pct->valuedouble);
    snprintf(out, out_len, "backlight at %d%%", bsp_display_backlight_get());
    return true;
}

static int arg_volume(const cJSON *args)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(args, "volume");
    return cJSON_IsNumber(v) ? (int)v->valuedouble : -1; // -1: leave the setting alone
}

static bool require_speaker(char *err, size_t err_len)
{
    if (bsp_speaker_available()) return true;
    snprintf(err, err_len, "no speaker is fitted on this device");
    return false;
}

static bool tool_play_sound(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len)
{
    if (!require_speaker(err, err_len)) return false;
    const cJSON *name = cJSON_GetObjectItemCaseSensitive(args, "sound");
    char list[240];
    sounds_list(list, sizeof(list));
    if (!cJSON_IsString(name)) {
        snprintf(err, err_len, "pick a sound: %s", list);
        return false;
    }
    if (!sounds_play(name->valuestring, arg_volume(args))) {
        snprintf(err, err_len, "there is no \"%s\" sound; pick one of: %s", name->valuestring, list);
        return false;
    }
    snprintf(out, out_len, "played the %s sound", name->valuestring);
    return true;
}

static bool tool_play_tone(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len)
{
    if (!require_speaker(err, err_len)) return false;
    const cJSON *hz = cJSON_GetObjectItemCaseSensitive(args, "hz");
    const cJSON *ms = cJSON_GetObjectItemCaseSensitive(args, "ms");
    if (!cJSON_IsNumber(hz)) {
        snprintf(err, err_len, "give a frequency in hz, between 50 and 8000");
        return false;
    }
    int freq = (int)hz->valuedouble;
    int len = cJSON_IsNumber(ms) ? (int)ms->valuedouble : 200;
    freq = freq < 50 ? 50 : (freq > 8000 ? 8000 : freq);
    len = len < 20 ? 20 : (len > 5000 ? 5000 : len);

    bsp_speaker_tone(freq, len, arg_volume(args));
    snprintf(out, out_len, "played %d Hz for %d ms", freq, len);
    return true;
}

static bool tool_play_melody(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len)
{
    if (!require_speaker(err, err_len)) return false;
    const cJSON *notes = cJSON_GetObjectItemCaseSensitive(args, "notes");
    if (!cJSON_IsString(notes)) {
        snprintf(err, err_len, "give the notes, like \"C4:200 E4 G4:400\"");
        return false;
    }
    const int ms = sounds_melody(notes->valuestring, arg_volume(args), err, err_len);
    if (ms < 0) return false;
    snprintf(out, out_len, "played %.1f seconds of music", ms / 1000.0);
    return true;
}

static bool tool_speaker_set(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len)
{
    if (!require_speaker(err, err_len)) return false;
    const cJSON *vol = cJSON_GetObjectItemCaseSensitive(args, "volume");
    const cJSON *muted = cJSON_GetObjectItemCaseSensitive(args, "muted");
    if (!cJSON_IsNumber(vol) && !cJSON_IsBool(muted)) {
        snprintf(err, err_len, "set a volume from 0 to 100, or muted true/false");
        return false;
    }
    // Muting remembers where the volume was, so unmuting can put it back.
    static int before_mute = -1;
    if (before_mute < 0) before_mute = settings_get(SET_VOLUME);
    if (cJSON_IsBool(muted)) {
        if (cJSON_IsTrue(muted)) {
            if (bsp_speaker_volume() > 0) before_mute = bsp_speaker_volume();
            bsp_speaker_set_volume(0);
        } else if (bsp_speaker_volume() == 0) {
            bsp_speaker_set_volume(before_mute);
        }
    }
    if (cJSON_IsNumber(vol)) bsp_speaker_set_volume((int)vol->valuedouble);

    const int now = bsp_speaker_volume();
    snprintf(out, out_len, "speaker volume is %d%%%s", now, now == 0 ? " (silent)" : "");
    return true;
}

const aiterm_tool_t DEVICE_TOOLS[] = {
    {
        .name = "led_set",
        .description = "Set the terminal's on-board RGB LED to a colour. This is the only light on the device.",
        .parameters = "{\"type\":\"object\",\"properties\":{"
                      "\"color\":{\"type\":\"string\",\"description\":\"colour name (red, green, blue, amber, purple, "
                      "cyan, white, off, …) or hex like #ff8800\"},"
                      "\"brightness\":{\"type\":\"number\",\"minimum\":0,\"maximum\":100}},"
                      "\"required\":[\"color\"],\"additionalProperties\":false}",
        .risk = "modify",
        .run = tool_led_set,
    },
    {
        .name = "led_blink",
        .description = "Blink the on-board LED a few times, then return it to its current colour.",
        .parameters = "{\"type\":\"object\",\"properties\":{"
                      "\"color\":{\"type\":\"string\"},"
                      "\"times\":{\"type\":\"integer\",\"minimum\":1,\"maximum\":20},"
                      "\"interval_ms\":{\"type\":\"integer\",\"minimum\":50,\"maximum\":2000},"
                      "\"brightness\":{\"type\":\"number\",\"minimum\":0,\"maximum\":100}},"
                      "\"required\":[\"color\"],\"additionalProperties\":false}",
        .risk = "modify",
        .run = tool_led_blink,
    },
    {
        .name = "record_audio",
        .description = "Record a few seconds from the terminal's microphone. The clip is uploaded and can be played, "
                       "and transcribed, in the dashboard. You do not get the words back here: this captures "
                       "sound, it does not read it.",
        .parameters = "{\"type\":\"object\",\"properties\":{"
                      "\"seconds\":{\"type\":\"integer\",\"minimum\":1,\"maximum\":30}},"
                      "\"required\":[],\"additionalProperties\":false}",
        .risk = "modify",
        .run = tool_record_audio,
    },
    {
        .name = "display_text",
        .description = "Show text on the terminal's 240x240 panel. Keep it short: about 28 characters per line at "
                       "size 1, and roughly 12 lines fit.",
        .parameters = "{\"type\":\"object\",\"properties\":{"
                      "\"text\":{\"type\":\"string\",\"description\":\"body text; it is wrapped on word boundaries\"},"
                      "\"title\":{\"type\":\"string\",\"description\":\"optional heading in the accent colour\"},"
                      "\"color\":{\"type\":\"string\",\"enum\":[\"amber\",\"green\",\"red\",\"blue\",\"dim\"]},"
                      "\"size\":{\"type\":\"integer\",\"minimum\":1,\"maximum\":3}},"
                      "\"required\":[\"text\"],\"additionalProperties\":false}",
        .risk = "modify",
        .run = tool_display_text,
    },
    {
        .name = "display_fill",
        .description = "Fill the whole panel with one colour. Useful for checking the display or flashing a signal.",
        .parameters = "{\"type\":\"object\",\"properties\":{"
                      "\"color\":{\"type\":\"string\",\"description\":\"colour name or hex like #ff8800\"}},"
                      "\"required\":[\"color\"],\"additionalProperties\":false}",
        .risk = "modify",
        .run = tool_display_fill,
    },
    {
        .name = "display_pattern",
        .description = "Draw a test pattern on the panel to check it: colour bars, a grid, or a grey gradient.",
        .parameters = "{\"type\":\"object\",\"properties\":{"
                      "\"pattern\":{\"type\":\"string\",\"enum\":[\"bars\",\"grid\",\"gradient\"]}},"
                      "\"required\":[\"pattern\"],\"additionalProperties\":false}",
        .risk = "modify",
        .run = tool_display_pattern,
    },
    {
        .name = "display_backlight",
        .description = "Set the panel backlight brightness, 0 to 100 percent. 0 turns the screen dark without "
                       "clearing what is on it.",
        .parameters = "{\"type\":\"object\",\"properties\":{"
                      "\"percent\":{\"type\":\"integer\",\"minimum\":0,\"maximum\":100}},"
                      "\"required\":[\"percent\"],\"additionalProperties\":false}",
        .risk = "modify",
        .run = tool_display_backlight,
    },
    {
        .name = "play_sound",
        .description = "Play one of the terminal's built-in sounds through its speaker. Prefer these over inventing "
                       "tones: beep to acknowledge, ok when something worked, error when it did not, chime or alert "
                       "to get attention, tick for counting, done when a job finishes.",
        .parameters = "{\"type\":\"object\",\"properties\":{"
                      "\"sound\":{\"type\":\"string\",\"enum\":[\"beep\",\"ok\",\"error\",\"alert\",\"chime\","
                      "\"tick\",\"listening\",\"done\",\"boot\",\"alarm\"]},"
                      "\"volume\":{\"type\":\"integer\",\"minimum\":0,\"maximum\":100}},"
                      "\"required\":[\"sound\"],\"additionalProperties\":false}",
        .risk = "modify",
        .run = tool_play_sound,
    },
    {
        .name = "play_tone",
        .description = "Play a single tone at a given pitch and length. For anything expressive prefer play_sound "
                       "or play_melody; this is for when a precise frequency matters.",
        .parameters = "{\"type\":\"object\",\"properties\":{"
                      "\"hz\":{\"type\":\"integer\",\"minimum\":50,\"maximum\":8000},"
                      "\"ms\":{\"type\":\"integer\",\"minimum\":20,\"maximum\":5000},"
                      "\"volume\":{\"type\":\"integer\",\"minimum\":0,\"maximum\":100}},"
                      "\"required\":[\"hz\"],\"additionalProperties\":false}",
        .risk = "modify",
        .run = tool_play_tone,
    },
    {
        .name = "play_melody",
        .description = "Play a short tune. Notes are separated by spaces: a letter A-G, an optional # or b, an "
                       "octave 1-8, and an optional :milliseconds that carries over to the notes after it. Use - "
                       "for a rest. \"C4:150 E4 G4 C5:400\" is a rising arpeggio. 20 seconds at most.",
        .parameters = "{\"type\":\"object\",\"properties\":{"
                      "\"notes\":{\"type\":\"string\",\"description\":\"for example: C4:200 E4 G4:400 -:100 C5\"},"
                      "\"volume\":{\"type\":\"integer\",\"minimum\":0,\"maximum\":100}},"
                      "\"required\":[\"notes\"],\"additionalProperties\":false}",
        .risk = "modify",
        .run = tool_play_melody,
    },
    {
        .name = "speaker_set",
        .description = "Set how loud the terminal is, from 0 (silent) to 100. The amplifier has no volume control "
                       "of its own, so this scales the audio itself.",
        .parameters = "{\"type\":\"object\",\"properties\":{"
                      "\"volume\":{\"type\":\"integer\",\"minimum\":0,\"maximum\":100},"
                      "\"muted\":{\"type\":\"boolean\"}},"
                      "\"required\":[],\"additionalProperties\":false}",
        .risk = "modify",
        .run = tool_speaker_set,
    },
    {
        .name = "device_status",
        .description = "Uptime, free memory, Wi-Fi signal, IP address, firmware version, and the state of the LED, "
                       "microphone, display, push-to-talk button and speaker.",
        .parameters = "{\"type\":\"object\",\"properties\":{},\"additionalProperties\":false}",
        .risk = "info",
        .run = tool_device_status,
    },
};

const size_t DEVICE_TOOL_COUNT = sizeof(DEVICE_TOOLS) / sizeof(DEVICE_TOOLS[0]);
