#include <inttypes.h>
#include "esp_check.h"
#include "esp_chip_info.h"
#include "esp_flash.h"
#include "esp_log.h"
#include "esp_pm.h"
#include "esp_psram.h"
#include "esp_sleep.h"
#include "led_strip.h"

#include "bsp.h"

static const char *TAG = "bsp";

static led_strip_handle_t s_led;
// The last colour asked for, unscaled, and the global scale applied to it. Keeping
// the request separate from what was sent means changing the brightness can re-send
// the same colour at the new level, rather than fading whatever happens to be lit.
static uint8_t s_want[3];
static int s_led_brightness = 100;
// Held dark without forgetting the colour, so the panel going to sleep can take the
// LED with it and waking up restores whatever was showing.
static bool s_blanked;
// The exception to that: something unread is waiting, so a dim amber stays alight
// through the blank. Scaled by the brightness setting like everything else, and off
// entirely when the LED has been turned down to zero.
static bool s_notify;

#define NOTIFY_R 40
#define NOTIFY_G 26
#define NOTIFY_B 0

static esp_err_t status_led_init(int gpio)
{
    const led_strip_config_t strip_config = {
        .strip_gpio_num = gpio,
        .max_leds = 1,
        .led_model = LED_MODEL_WS2812,
        .color_component_format = LED_STRIP_COLOR_COMPONENT_FMT_GRB,
    };
    const led_strip_rmt_config_t rmt_config = {
        .resolution_hz = 10 * 1000 * 1000,
    };
    ESP_RETURN_ON_ERROR(led_strip_new_rmt_device(&strip_config, &rmt_config, &s_led), TAG, "status LED");
    return led_strip_clear(s_led);
}

esp_err_t bsp_init(const bsp_config_t *cfg)
{
    if (cfg->status_led_gpio >= 0) {
        ESP_RETURN_ON_ERROR(status_led_init(cfg->status_led_gpio), TAG, "init");
    }
    return ESP_OK;
}

void bsp_log_chip_info(void)
{
    esp_chip_info_t chip;
    esp_chip_info(&chip);

    uint32_t flash_size = 0;
    esp_flash_get_size(NULL, &flash_size);

    ESP_LOGI(TAG, "%s rev v%d.%d, %d cores, flash %" PRIu32 " MB, PSRAM %u MB",
             CONFIG_IDF_TARGET, chip.revision / 100, chip.revision % 100, chip.cores,
             flash_size / (1024 * 1024), (unsigned)(esp_psram_get_size() / (1024 * 1024)));
}

// The brightness scale lives here rather than at the call sites so every caller —
// the wifi and link status colours, the led_set and led_blink tools — is scaled
// without knowing about it.
static void push_led(void)
{
    if (!s_led) return;
    const int scale = s_led_brightness;
    if (s_blanked) {
        // Asleep means asleep, unless there is something waiting to be read: then a
        // dim amber is the whole point, so it survives the blank.
        if (!s_notify || scale == 0) {
            led_strip_clear(s_led);
        } else {
            led_strip_set_pixel(s_led, 0, (uint8_t)(NOTIFY_R * scale / 100), (uint8_t)(NOTIFY_G * scale / 100),
                                (uint8_t)(NOTIFY_B * scale / 100));
            led_strip_refresh(s_led);
        }
        return;
    }
    const uint8_t r = (uint8_t)(s_want[0] * scale / 100);
    const uint8_t g = (uint8_t)(s_want[1] * scale / 100);
    const uint8_t b = (uint8_t)(s_want[2] * scale / 100);
    if (!r && !g && !b) {
        led_strip_clear(s_led);
    } else {
        led_strip_set_pixel(s_led, 0, r, g, b);
        led_strip_refresh(s_led);
    }
}

void bsp_status_led_set(uint8_t r, uint8_t g, uint8_t b)
{
    s_want[0] = r;
    s_want[1] = g;
    s_want[2] = b;
    push_led();
}

void bsp_status_led_get(uint8_t *r, uint8_t *g, uint8_t *b)
{
    if (r) *r = s_want[0];
    if (g) *g = s_want[1];
    if (b) *b = s_want[2];
}

void bsp_status_led_brightness(int percent)
{
    s_led_brightness = percent < 0 ? 0 : (percent > 100 ? 100 : percent);
    push_led(); // so the change is visible at once, not at the next status change
}

int bsp_status_led_brightness_get(void)
{
    return s_led_brightness;
}

void bsp_status_led_blank(bool blank)
{
    if (s_blanked == blank) return;
    s_blanked = blank;
    push_led();
}

bool bsp_status_led_blanked(void)
{
    return s_blanked;
}

void bsp_status_led_notify(bool waiting)
{
    if (s_notify == waiting) return;
    s_notify = waiting;
    // Only matters while the panel is dark; the rest of the time the status colour
    // is what should be showing.
    if (s_blanked) push_led();
}

// ─── power ───────────────────────────────────────────────────────────────

static bool s_sleep_allowed;

void bsp_power_allow_sleep(bool allow)
{
    const esp_pm_config_t pm = {
        .max_freq_mhz = 240,
        // Pinned to the top when sleep is off, so this is not merely "no sleep" but
        // no frequency scaling either: whatever the cable is doing, nothing changes
        // underneath it.
        .min_freq_mhz = allow ? 80 : 240,
        .light_sleep_enable = allow,
    };
    const esp_err_t err = esp_pm_configure(&pm);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "power management would not take that: %s", esp_err_to_name(err));
        return;
    }
    s_sleep_allowed = allow;
    ESP_LOGI(TAG, "power saving %s (%d-240 MHz, light sleep %s)", allow ? "on" : "off", allow ? 80 : 240,
             allow ? "on" : "off");
}

bool bsp_power_sleep_allowed(void)
{
    return s_sleep_allowed;
}

esp_err_t bsp_power_init(void)
{
    // The keys and the talk button each register themselves as wake pins; this is
    // the one global switch that makes any of them count. Harmless with sleep off.
    const esp_err_t err = esp_sleep_enable_gpio_wakeup();
    if (err != ESP_OK) ESP_LOGW(TAG, "gpio wakeup: %s", esp_err_to_name(err));
    bsp_power_allow_sleep(false); // the setting turns it on later, if it is on
    return ESP_OK;
}
