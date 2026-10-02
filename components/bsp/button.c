#include <stdlib.h>

#include "driver/gpio.h"
#include "esp_check.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "bsp.h"

// One momentary button, debounced on its own task.
//
// It used to poll every 10 ms for ever. The objection to an interrupt was that the
// callbacks start a recording, which an ISR cannot do — still true, and still the
// reason the work happens on a task. What changed is that the task now blocks until
// the interrupt notifies it, instead of waking a hundred times a second whether or
// not anything has happened, which is what let the chip idle at all.
//
// Level triggered rather than edge, because that is what can wake the chip out of
// light sleep. The handler masks its own pin so a held button is not an interrupt
// storm, and the task re-arms it once the button is up.

static const char *TAG = "bsp.btn";

#define POLL_MS     10
#define DEBOUNCE_MS 30
#define STABLE      (DEBOUNCE_MS / POLL_MS)
// How long it has to stay up before the task stops sampling and waits again.
#define QUIET_MS    120
#define QUIET_TICKS (QUIET_MS / POLL_MS)

static bsp_button_config_t s_cfg;
static volatile bool s_down;
static TaskHandle_t s_task;

static bool read_raw(void)
{
    const int level = gpio_get_level(s_cfg.gpio);
    return s_cfg.active_low ? level == 0 : level == 1;
}

static void IRAM_ATTR button_isr(void *arg)
{
    gpio_intr_disable((gpio_num_t)s_cfg.gpio); // re-armed by the task once it is up
    BaseType_t woken = pdFALSE;
    vTaskNotifyGiveFromISR(s_task, &woken);
    if (woken) portYIELD_FROM_ISR();
}

static void button_task(void *arg)
{
    bool stable = false; // the debounced state
    int agree = 0;       // consecutive samples that disagree with it
    int64_t pressed_at = 0;

    while (true) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);

        int quiet = 0;
        while (quiet < QUIET_TICKS) {
            vTaskDelay(pdMS_TO_TICKS(POLL_MS));
            const bool raw = read_raw();
            if (raw != stable && ++agree >= STABLE) {
                stable = raw;
                agree = 0;
                s_down = stable;
                if (stable) {
                    pressed_at = esp_timer_get_time();
                    if (s_cfg.on_press) s_cfg.on_press(s_cfg.ctx);
                } else {
                    const int held = (int)((esp_timer_get_time() - pressed_at) / 1000);
                    if (s_cfg.on_release) s_cfg.on_release(s_cfg.ctx, held);
                }
            } else if (raw == stable) {
                agree = 0;
            }
            quiet = read_raw() ? 0 : quiet + 1;
        }

        gpio_intr_enable((gpio_num_t)s_cfg.gpio);
        // A press between the last sample and the re-arm raised nothing, because the
        // pin was masked at the time.
        if (read_raw()) xTaskNotifyGive(s_task);
    }
}

esp_err_t bsp_button_init(const bsp_button_config_t *cfg)
{
    if (!cfg || cfg->gpio < 0) return ESP_ERR_INVALID_ARG;
    s_cfg = *cfg;

    const gpio_config_t io = {
        .pin_bit_mask = 1ULL << cfg->gpio,
        .mode = GPIO_MODE_INPUT,
        // The switch shorts the pin to the rail it is not pulled to, so the pull
        // has to be on the opposite side: to GND means pull up.
        .pull_up_en = cfg->active_low ? GPIO_PULLUP_ENABLE : GPIO_PULLUP_DISABLE,
        .pull_down_en = cfg->active_low ? GPIO_PULLDOWN_DISABLE : GPIO_PULLDOWN_ENABLE,
        .intr_type = cfg->active_low ? GPIO_INTR_LOW_LEVEL : GPIO_INTR_HIGH_LEVEL,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&io), TAG, "gpio %d", cfg->gpio);

    if (xTaskCreate(button_task, "button", 3072, NULL, 5, &s_task) != pdPASS) return ESP_ERR_NO_MEM;

    esp_err_t err = gpio_install_isr_service(0);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err; // already installed is fine
    ESP_RETURN_ON_ERROR(gpio_isr_handler_add(cfg->gpio, button_isr, NULL), TAG, "button isr");
    // The mic button wakes the panel and starts recording, so it has to be able to
    // wake the chip as well.
    gpio_wakeup_enable(cfg->gpio, cfg->active_low ? GPIO_INTR_LOW_LEVEL : GPIO_INTR_HIGH_LEVEL);
    ESP_LOGI(TAG, "button on GPIO%d, active %s, internal pull-%s", cfg->gpio, cfg->active_low ? "low" : "high",
             cfg->active_low ? "up" : "down");
    return ESP_OK;
}

bool bsp_button_down(void)
{
    return s_down;
}

void bsp_button_inject(int held_ms)
{
    // Straight to the callbacks, in the order the poller would call them. The gap
    // between two injected taps is real wall time, which is what the double-tap
    // detection actually measures, so the gesture behaves as it would under a finger.
    if (s_cfg.on_press) s_cfg.on_press(s_cfg.ctx);
    if (s_cfg.on_release) s_cfg.on_release(s_cfg.ctx, held_ms);
}
