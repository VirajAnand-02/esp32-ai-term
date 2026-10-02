#include <string.h>

#include "driver/gpio.h"
#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "bsp.h"

// The navigation cluster: the five-way switch and the back button, each a momentary
// contact to ground. Debounced together on one task, which keeps the bounce handling
// in one place.
//
// It used to sample every 10 ms for ever, which was simpler and cost nothing that
// mattered until the device ran on a battery: a hundred wake-ups a second means the
// CPU is never idle for longer than 10 ms, and tickless idle and light sleep never
// happen at all. So now the task blocks on a notification and an interrupt wakes it,
// and the 10 ms sampling only runs while something is actually being pressed — the
// same debounce, just not all the time.
//
// The interrupts are level triggered, because that is what can also wake the chip
// from light sleep. A level interrupt would fire continuously while the key is held
// down, so the handler masks its own pin and the task re-arms it once the key is up.
//
// Two ways to read it, because the shell wants both: bsp_key_down() for "is it held
// now", which is what a held direction repeating a value needs, and a small queue of
// edges so a tap between two frames is never missed.

static const char *TAG = "bsp.keys";

#define POLL_MS     10
#define DEBOUNCE_MS 30
#define STABLE      (DEBOUNCE_MS / POLL_MS)
#define EVENTS      16
// How long everything has to stay released before the task stops sampling and goes
// back to waiting. Long enough to cover the bounce on release, short enough that the
// CPU is idle again almost immediately.
#define QUIET_MS    120
#define QUIET_TICKS (QUIET_MS / POLL_MS)

static bsp_keys_config_t s_cfg;
static volatile bool s_down[BSP_KEY_COUNT];
static QueueHandle_t s_events;
static bool s_ready;
static TaskHandle_t s_task;

static const char *const NAMES[BSP_KEY_COUNT] = {"up", "down", "left", "right", "ok", "back"};

const char *bsp_key_name(bsp_key_t key)
{
    return key >= 0 && key < BSP_KEY_COUNT ? NAMES[key] : "?";
}

static bool read_raw(int key)
{
    if (s_cfg.gpio[key] < 0) return false;
    const int level = gpio_get_level(s_cfg.gpio[key]);
    return s_cfg.active_low ? level == 0 : level == 1;
}

static bool any_raw_down(void)
{
    for (int k = 0; k < BSP_KEY_COUNT; k++) {
        if (read_raw(k)) return true;
    }
    return false;
}

static void arm_interrupts(void)
{
    for (int k = 0; k < BSP_KEY_COUNT; k++) {
        if (s_cfg.gpio[k] >= 0) gpio_intr_enable(s_cfg.gpio[k]);
    }
}

static void IRAM_ATTR key_isr(void *arg)
{
    // Level triggered, so this would re-enter for as long as the contact is closed.
    // Masking the pin here and re-arming from the task is what keeps one press from
    // becoming an interrupt storm.
    gpio_intr_disable((gpio_num_t)(intptr_t)arg);
    BaseType_t woken = pdFALSE;
    vTaskNotifyGiveFromISR(s_task, &woken);
    if (woken) portYIELD_FROM_ISR();
}

static void keys_task(void *arg)
{
    bool stable[BSP_KEY_COUNT] = {false};
    int agree[BSP_KEY_COUNT] = {0};

    while (true) {
        // Nothing is pressed, so there is nothing to do and nothing to wake for.
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);

        int quiet = 0;
        while (quiet < QUIET_TICKS) {
            vTaskDelay(pdMS_TO_TICKS(POLL_MS));
            for (int k = 0; k < BSP_KEY_COUNT; k++) {
                const bool raw = read_raw(k);
                if (raw == stable[k]) {
                    agree[k] = 0;
                    continue;
                }
                if (++agree[k] < STABLE) continue;

                stable[k] = raw;
                agree[k] = 0;
                s_down[k] = raw;

                // Oldest events win: a full queue means nobody is reading, and the
                // newest press is no more interesting than the one before it.
                const bsp_key_event_t ev = {.key = (bsp_key_t)k, .down = raw};
                xQueueSend(s_events, &ev, 0);
                if (s_cfg.on_key) s_cfg.on_key(ev.key, ev.down, s_cfg.ctx);
            }
            quiet = any_raw_down() ? 0 : quiet + 1;
        }

        arm_interrupts();
        // A press that landed between the last sample and the re-arm would have been
        // masked at the time and so raised nothing: check once more, now that the
        // interrupts are live again.
        if (any_raw_down()) xTaskNotifyGive(s_task);
    }
}

esp_err_t bsp_keys_init(const bsp_keys_config_t *cfg)
{
    if (!cfg) return ESP_ERR_INVALID_ARG;
    s_cfg = *cfg;

    uint64_t mask = 0;
    for (int k = 0; k < BSP_KEY_COUNT; k++) {
        if (cfg->gpio[k] >= 0) mask |= 1ULL << cfg->gpio[k];
    }
    if (!mask) return ESP_ERR_INVALID_ARG;

    const gpio_config_t io = {
        .pin_bit_mask = mask,
        .mode = GPIO_MODE_INPUT,
        // Each contact shorts its pin to the rail it is not pulled to, so a switch
        // to GND needs the internal pull-up. Same reasoning as the talk button.
        .pull_up_en = cfg->active_low ? GPIO_PULLUP_ENABLE : GPIO_PULLUP_DISABLE,
        .pull_down_en = cfg->active_low ? GPIO_PULLDOWN_DISABLE : GPIO_PULLDOWN_ENABLE,
        // Low level when a press pulls the pin to ground, high when it pushes it up.
        // A level trigger rather than an edge because this is also the wake source
        // out of light sleep, which edges cannot be.
        .intr_type = cfg->active_low ? GPIO_INTR_LOW_LEVEL : GPIO_INTR_HIGH_LEVEL,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&io), TAG, "key gpios");

    s_events = xQueueCreate(EVENTS, sizeof(bsp_key_event_t));
    if (!s_events) return ESP_ERR_NO_MEM;
    if (xTaskCreate(keys_task, "keys", 3072, NULL, 5, &s_task) != pdPASS) {
        vQueueDelete(s_events);
        s_events = NULL;
        return ESP_ERR_NO_MEM;
    }

    // Shared, so this coexists with whatever else wants a GPIO interrupt.
    esp_err_t err = gpio_install_isr_service(0);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err; // already installed is fine
    for (int k = 0; k < BSP_KEY_COUNT; k++) {
        const int gpio = cfg->gpio[k];
        if (gpio < 0) continue;
        ESP_RETURN_ON_ERROR(gpio_isr_handler_add(gpio, key_isr, (void *)(intptr_t)gpio), TAG, "key isr");
        // Also a wake source, so a press brings the chip back out of light sleep and
        // then does its normal job.
        gpio_wakeup_enable(gpio, cfg->active_low ? GPIO_INTR_LOW_LEVEL : GPIO_INTR_HIGH_LEVEL);
    }

    s_ready = true;
    ESP_LOGI(TAG, "keys up=%d down=%d left=%d right=%d ok=%d back=%d, active %s",
             cfg->gpio[BSP_KEY_UP], cfg->gpio[BSP_KEY_DOWN], cfg->gpio[BSP_KEY_LEFT],
             cfg->gpio[BSP_KEY_RIGHT], cfg->gpio[BSP_KEY_OK], cfg->gpio[BSP_KEY_BACK],
             cfg->active_low ? "low" : "high");
    return ESP_OK;
}

bool bsp_keys_available(void)
{
    return s_ready;
}

bool bsp_key_down(bsp_key_t key)
{
    return key >= 0 && key < BSP_KEY_COUNT && s_down[key];
}

bool bsp_keys_wait(bsp_key_event_t *out, uint32_t timeout_ms)
{
    if (!s_events || !out) return false;
    return xQueueReceive(s_events, out, pdMS_TO_TICKS(timeout_ms)) == pdTRUE;
}

void bsp_keys_flush(void)
{
    if (s_events) xQueueReset(s_events);
}

bool bsp_keys_press_pin(bsp_key_t key, int hold_ms)
{
    if (!s_ready || key < 0 || key >= BSP_KEY_COUNT) return false;
    const int gpio = s_cfg.gpio[key];
    if (gpio < 0) return false;
    if (hold_ms < 10) hold_ms = 10;

    // Output low is exactly what closing the switch does, so nothing is being fought
    // here. Going back to input hands the pin to the internal pull-up again, which
    // is the release.
    gpio_set_direction((gpio_num_t)gpio, GPIO_MODE_OUTPUT);
    gpio_set_level((gpio_num_t)gpio, s_cfg.active_low ? 0 : 1);
    vTaskDelay(pdMS_TO_TICKS(hold_ms));
    gpio_set_direction((gpio_num_t)gpio, GPIO_MODE_INPUT);
    return true;
}

void bsp_keys_inject(bsp_key_t key)
{
    if (!s_events || key < 0 || key >= BSP_KEY_COUNT) return;
    // A press and its release, onto the same queue the poller uses, so everything
    // above this cannot tell the difference. The held latch is deliberately not
    // touched: an injected key is a tap, and pretending it is held would leave it
    // stuck down with nothing to release it.
    const bsp_key_event_t down = {.key = key, .down = true};
    const bsp_key_event_t up = {.key = key, .down = false};
    xQueueSend(s_events, &down, 0);
    xQueueSend(s_events, &up, 0);
}
