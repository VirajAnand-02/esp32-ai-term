#pragma once

#include <stdbool.h>
#include "cJSON.h"
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

// Everything about this device that survives a reboot.
//
// One table in settings.c owns each setting's name, range, default and how it is
// applied, because the same facts were previously needed in four places — the board
// header, a literal inside the display driver, a static in the LED tool, and the
// driver's own fallback — and they had already drifted apart.
//
// Three callers, one table: the settings screen reads the spec to draw a row, the
// dashboard pushes JSON, and NVS stores it.

typedef enum {
    SET_DISPLAY_BRIGHTNESS,
    SET_LED_BRIGHTNESS,
    SET_VOLUME,
    SET_MIC_GAIN_SHIFT,
    SET_UI_SOUNDS,
    SET_DIM_AFTER_S,
    SET_BLANK_AFTER_S,
    SET_POWER_SAVE, // frequency scaling and light sleep; costs the serial console
    // Below here are settings with a screen of their own. They still persist and
    // still sync with the dashboard; they are just not in the settings list, where
    // "clock style: 1" would mean nothing to anybody.
    SET_CLOCK_STYLE, // 0 digital, 1 analog
    SET_POMO_WORK,   // minutes
    SET_POMO_SHORT,
    SET_POMO_LONG,
    SET_COUNT,
} setting_id_t;

typedef struct {
    const char *nvs_key;  // <= 15 characters; NVS rejects anything longer
    const char *json_key; // what the dashboard sends and sees; free to be readable
    const char *label;    // the settings screen's row label
    const char *unit;     // "%", "s", or "" — drawn after the value
    int min, max, step;
    int def;
    bool is_bool; // drawn as on/off, and toggled rather than nudged
    bool hidden;  // owned by another screen; kept out of the settings list
} setting_spec_t;

const setting_spec_t *settings_spec(setting_id_t id);

// The settings list walks these rather than the whole enum, so a setting with a
// screen of its own does not also turn up as a bare number.
int settings_visible_count(void);
setting_id_t settings_visible_at(int index);

// Loads from NVS, falling back to each spec's default. Call after nvs_flash_init()
// and before the peripherals are set up, so their init can start at the right value
// rather than coming up wrong and being corrected a moment later.
esp_err_t settings_init(void);

int settings_get(setting_id_t id);

// Clamps to the spec, applies to the hardware at once, and schedules a save.
// Returns true if the value actually changed.
bool settings_set(setting_id_t id, int value);

// Pushes every setting into the hardware. Call once the peripherals are up.
void settings_apply_all(void);

// Writes any pending change now instead of waiting out the debounce.
void settings_flush(void);

void settings_to_json(cJSON *out);

// The dashboard's push. Unknown keys are ignored, bad values clamped. Returns how
// many settings actually changed.
int settings_from_json(const cJSON *in);

// Called after a change has been committed, so the device can tell the server.
// Fires on the debounced commit, not on every nudge of a held key.
void settings_on_commit(void (*cb)(void));

#ifdef __cplusplus
}
#endif
