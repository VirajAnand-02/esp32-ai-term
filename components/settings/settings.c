#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "bsp.h"
#include "settings.h"
#include "ui.h"

static const char *TAG = "settings";

#define NAMESPACE "aiterm"

// Writing on every nudge would put thirty commits into flash for one sweep of a
// brightness row. Apply immediately so the panel responds, and commit once the key
// has been still for this long.
#define COMMIT_DELAY_US (2 * 1000 * 1000)

// NVS keys are capped at 15 characters, which is why they are abbreviated while the
// JSON names stay readable. The JSON names are also the dashboard's contract:
// mic_gain_shift, display_brightness and volume are already in use, so they do not
// get to change.
static const setting_spec_t SPECS[SET_COUNT] = {
    [SET_DISPLAY_BRIGHTNESS] = {"disp_bright", "display_brightness", "brightness", "%", 5, 100, 5, 80, false},
    [SET_LED_BRIGHTNESS]     = {"led_bright", "led_brightness", "led", "%", 0, 100, 10, 100, false},
    [SET_VOLUME]             = {"volume", "volume", "volume", "%", 0, 100, 5, 55, false},
    // Lower is louder, and the useful band is narrow; outside 8-24 the mic driver
    // rejects it outright.
    [SET_MIC_GAIN_SHIFT]     = {"mic_gain", "mic_gain_shift", "mic gain", "", 8, 24, 1, 16, false},
    [SET_UI_SOUNDS]          = {"ui_sounds", "ui_sounds", "ui sounds", "", 0, 1, 1, 1, true},
    [SET_DIM_AFTER_S]        = {"dim_s", "dim_after_s", "dim after", "s", 0, 600, 15, 120, false},
    [SET_BLANK_AFTER_S]      = {"blank_s", "blank_after_s", "blank after", "s", 0, 1800, 60, 600, false},
    // Off by default, and deliberately so: turning it on stops the USB console
    // working, which is how this device is developed and tested. It is worth having
    // on when the thing is actually running off its battery.
    [SET_POWER_SAVE]         = {"pwr_save", "power_save", "power saving", "", 0, 1, 1, 0, true},
    [SET_CLOCK_STYLE]        = {"clock_style", "clock_style", "clock face", "", 0, 1, 1, 0, false, true},
    [SET_POMO_WORK]          = {"pomo_work", "pomodoro_work_min", "focus", "m", 5, 90, 5, 25, false, true},
    [SET_POMO_SHORT]         = {"pomo_short", "pomodoro_short_min", "short break", "m", 1, 30, 1, 5, false, true},
    [SET_POMO_LONG]          = {"pomo_long", "pomodoro_long_min", "long break", "m", 5, 60, 5, 15, false, true},
};

static int s_value[SET_COUNT];
static bool s_ready;
static bool s_dirty;
static esp_timer_handle_t s_commit_timer;
static void (*s_on_commit)(void);

const setting_spec_t *settings_spec(setting_id_t id)
{
    return id >= 0 && id < SET_COUNT ? &SPECS[id] : NULL;
}

int settings_visible_count(void)
{
    int n = 0;
    for (int i = 0; i < SET_COUNT; i++) {
        if (!SPECS[i].hidden) n++;
    }
    return n;
}

setting_id_t settings_visible_at(int index)
{
    for (int i = 0; i < SET_COUNT; i++) {
        if (SPECS[i].hidden) continue;
        if (index-- == 0) return (setting_id_t)i;
    }
    return SET_DISPLAY_BRIGHTNESS;
}

int settings_get(setting_id_t id)
{
    return id >= 0 && id < SET_COUNT ? s_value[id] : 0;
}

static int clamp_to(setting_id_t id, int v)
{
    const setting_spec_t *sp = &SPECS[id];
    if (v < sp->min) return sp->min;
    if (v > sp->max) return sp->max;
    return v;
}

// The one place a setting meets the hardware.
static void apply(setting_id_t id)
{
    switch (id) {
    case SET_DISPLAY_BRIGHTNESS: bsp_display_backlight(s_value[id]); break;
    case SET_LED_BRIGHTNESS:     bsp_status_led_brightness(s_value[id]); break;
    case SET_VOLUME:             bsp_speaker_set_volume(s_value[id]); break;
    case SET_MIC_GAIN_SHIFT:     bsp_mic_set_gain_shift(s_value[id]); break;
    case SET_UI_SOUNDS:          break; // read by sounds_play; nothing to push
    case SET_POWER_SAVE:         bsp_power_allow_sleep(s_value[id] != 0); break;
    case SET_CLOCK_STYLE:
    case SET_POMO_WORK:
    case SET_POMO_SHORT:
    case SET_POMO_LONG:
        break; // read where they are used; no hardware to push them to
    case SET_DIM_AFTER_S:
    case SET_BLANK_AFTER_S:
        ui_set_idle_dim(s_value[SET_DIM_AFTER_S], s_value[SET_BLANK_AFTER_S]);
        break;
    default: break;
    }
}

void settings_apply_all(void)
{
    for (int i = 0; i < SET_COUNT; i++) apply((setting_id_t)i);
}

static void commit(void *arg)
{
    if (!s_dirty) return;
    nvs_handle_t h;
    if (nvs_open(NAMESPACE, NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGW(TAG, "cannot open nvs to save");
        return;
    }
    for (int i = 0; i < SET_COUNT; i++) nvs_set_i32(h, SPECS[i].nvs_key, s_value[i]);
    const esp_err_t err = nvs_commit(h);
    nvs_close(h);
    s_dirty = false;
    ESP_LOGI(TAG, "saved (%s)", esp_err_to_name(err));
    if (s_on_commit) s_on_commit();
}

static void schedule_commit(void)
{
    s_dirty = true;
    if (!s_commit_timer) {
        commit(NULL); // no timer yet: this is a change during init, so write it now
        return;
    }
    esp_timer_stop(s_commit_timer); // restart the window, so a held key saves once
    esp_timer_start_once(s_commit_timer, COMMIT_DELAY_US);
}

bool settings_set(setting_id_t id, int value)
{
    if (id < 0 || id >= SET_COUNT) return false;
    const int v = clamp_to(id, value);
    if (s_value[id] == v) return false;
    s_value[id] = v;
    if (s_ready) apply(id);
    schedule_commit();
    return true;
}

esp_err_t settings_init(void)
{
    nvs_handle_t h;
    const esp_err_t open_err = nvs_open(NAMESPACE, NVS_READONLY, &h);

    for (int i = 0; i < SET_COUNT; i++) {
        s_value[i] = SPECS[i].def;
        if (open_err != ESP_OK) continue;
        int32_t stored = 0;
        // A key that has never been written is not an error; it just means this
        // setting has not been touched and the default stands.
        if (nvs_get_i32(h, SPECS[i].nvs_key, &stored) == ESP_OK) {
            s_value[i] = clamp_to((setting_id_t)i, (int)stored);
        }
    }
    if (open_err == ESP_OK) nvs_close(h);

    const esp_timer_create_args_t args = {.callback = commit, .name = "set_save"};
    if (esp_timer_create(&args, &s_commit_timer) != ESP_OK) {
        ESP_LOGW(TAG, "no debounce timer; saves will be immediate");
        s_commit_timer = NULL;
    }
    s_ready = true;

    ESP_LOGI(TAG, "%s: brightness %d%%, led %d%%, volume %d%%, mic gain %d, sounds %s, dim %ds/blank %ds",
             open_err == ESP_OK ? "loaded" : "defaults (nvs empty)", s_value[SET_DISPLAY_BRIGHTNESS],
             s_value[SET_LED_BRIGHTNESS], s_value[SET_VOLUME], s_value[SET_MIC_GAIN_SHIFT],
             s_value[SET_UI_SOUNDS] ? "on" : "off", s_value[SET_DIM_AFTER_S], s_value[SET_BLANK_AFTER_S]);
    return ESP_OK;
}

void settings_flush(void)
{
    if (s_commit_timer) esp_timer_stop(s_commit_timer);
    commit(NULL);
}

void settings_to_json(cJSON *out)
{
    if (!out) return;
    for (int i = 0; i < SET_COUNT; i++) {
        if (SPECS[i].is_bool) cJSON_AddBoolToObject(out, SPECS[i].json_key, s_value[i] != 0);
        else cJSON_AddNumberToObject(out, SPECS[i].json_key, s_value[i]);
    }
}

int settings_from_json(const cJSON *in)
{
    if (!in) return 0;
    int changed = 0;
    for (int i = 0; i < SET_COUNT; i++) {
        const cJSON *v = cJSON_GetObjectItemCaseSensitive(in, SPECS[i].json_key);
        if (cJSON_IsBool(v)) changed += settings_set((setting_id_t)i, cJSON_IsTrue(v) ? 1 : 0);
        else if (cJSON_IsNumber(v)) changed += settings_set((setting_id_t)i, (int)v->valuedouble);
    }
    if (changed) ESP_LOGI(TAG, "%d setting(s) changed from the dashboard", changed);
    return changed;
}

void settings_on_commit(void (*cb)(void))
{
    s_on_commit = cb;
}
