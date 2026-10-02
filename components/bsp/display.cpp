#include <LovyanGFX.hpp>

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "bsp.h"

// ST7789 over SPI, driven by LovyanGFX.
//
// esp_lcd's built-in ST7789 driver sends only SLPOUT / MADCTL / COLMOD and trusts
// the panel's power-on defaults for porch, gate, VCOM, VRH and gamma. This JMD-PS130
// takes every one of those commands without complaint and still shows nothing, so
// LovyanGFX's full vendor init is what actually lights it up. It also wants SPI
// mode 3 rather than mode 0.
//
// Drawing never goes straight to the panel: everything is composed in a full-screen
// sprite and pushed in one transfer, so animation can't tear or flicker.

static const char *TAG = "bsp.lcd";

#define BL_TIMER   LEDC_TIMER_0
#define BL_CHANNEL LEDC_CHANNEL_0
#define BL_MODE    LEDC_LOW_SPEED_MODE

namespace {

class Display : public lgfx::LGFX_Device {
public:
    lgfx::Panel_ST7789 panel;
    lgfx::Bus_SPI bus;

    void setup(const bsp_display_config_t *cfg)
    {
        auto b = bus.config();
        b.spi_host = SPI2_HOST;
        b.spi_mode = cfg->spi_mode;
        b.freq_write = cfg->hz;
        b.freq_read = 16 * 1000 * 1000;
        b.spi_3wire = true;   // the module's SDA is the only data line
        b.use_lock = true;
        b.dma_channel = SPI_DMA_CH_AUTO;
        b.pin_sclk = cfg->sclk_gpio;
        b.pin_mosi = cfg->mosi_gpio;
        b.pin_miso = -1;
        b.pin_dc = cfg->dc_gpio;
        bus.config(b);
        panel.setBus(&bus);

        auto p = panel.config();
        p.pin_cs = cfg->cs_gpio;   // -1: the 7-pin module grounds CS on the board
        p.pin_rst = cfg->rst_gpio;
        p.pin_busy = -1;
        p.memory_width = cfg->width;
        p.memory_height = cfg->height;
        p.panel_width = cfg->width;
        p.panel_height = cfg->height;
        p.offset_x = cfg->x_gap;
        p.offset_y = cfg->y_gap;
        p.offset_rotation = 0;
        p.dummy_read_pixel = 8;
        p.dummy_read_bits = 1;
        p.readable = false;       // nothing is wired back from the panel
        p.invert = cfg->invert;
        p.rgb_order = cfg->rgb_order;
        p.dlen_16bit = false;
        p.bus_shared = false;
        panel.config(p);

        setPanel(&panel);
    }
};

Display s_lcd;
LGFX_Sprite s_canvas(&s_lcd);
bool s_ready;
bool s_has_backlight;
int s_backlight = 100; // overwritten from the config at init
int s_width, s_height;

} // namespace

// Handed to the phase 0 bench, which needs the panel and the canvas themselves
// rather than the narrow C API.
lgfx::LGFX_Device *bsp_bench_lcd()
{
    return s_ready ? &s_lcd : nullptr;
}

LGFX_Sprite *bsp_bench_canvas()
{
    return s_ready ? &s_canvas : nullptr;
}

extern "C" {

static esp_err_t backlight_init(int gpio, int percent)
{
    const ledc_timer_config_t timer = {
        .speed_mode = BL_MODE,
        .duty_resolution = LEDC_TIMER_10_BIT,
        .timer_num = BL_TIMER,
        .freq_hz = 5000,
        .clk_cfg = LEDC_AUTO_CLK,
        .deconfigure = false,
    };
    ESP_RETURN_ON_ERROR(ledc_timer_config(&timer), TAG, "bl timer");
    ledc_channel_config_t channel = {};
    channel.gpio_num = gpio;
    channel.speed_mode = BL_MODE;
    channel.channel = BL_CHANNEL;
    channel.timer_sel = BL_TIMER;
    // Start at the level the caller asked for, not flat out. Coming up at 100% and
    // then dropping to the stored setting is a visible flash on every boot.
    channel.duty = (uint32_t)(percent * 1023 / 100);
    channel.hpoint = 0;
    ESP_RETURN_ON_ERROR(ledc_channel_config(&channel), TAG, "bl channel");
    return ESP_OK;
}

esp_err_t bsp_display_init(const bsp_display_config_t *cfg)
{
    if (cfg->sclk_gpio < 0 || cfg->mosi_gpio < 0 || cfg->dc_gpio < 0) return ESP_ERR_INVALID_ARG;
    s_width = cfg->width > 0 ? cfg->width : 240;
    s_height = cfg->height > 0 ? cfg->height : 240;

    s_lcd.setup(cfg);
    if (!s_lcd.init()) {
        ESP_LOGE(TAG, "the panel did not initialise");
        return ESP_FAIL;
    }
    s_lcd.setRotation(0);
    s_lcd.fillScreen(TFT_BLACK);

    // The back buffer lives in PSRAM: 240x240x16bpp is 115 KB, which is more
    // internal RAM than is worth spending next to the wifi stack.
    s_canvas.setPsram(true);
    s_canvas.setColorDepth(16);
    if (!s_canvas.createSprite(s_width, s_height)) {
        ESP_LOGE(TAG, "no room for the %dx%d back buffer", s_width, s_height);
        return ESP_ERR_NO_MEM;
    }
    s_canvas.setSwapBytes(false);

    const int bl = cfg->brightness > 0 ? (cfg->brightness > 100 ? 100 : cfg->brightness) : 100;
    if (cfg->bl_gpio >= 0 && backlight_init(cfg->bl_gpio, bl) == ESP_OK) {
        s_has_backlight = true;
        s_backlight = bl;
    }
    s_ready = true;

    ESP_LOGI(TAG, "%dx%d ST7789 via LovyanGFX: sclk=%d mosi=%d dc=%d rst=%d cs=%d bl=%d, %d MHz mode %d, "
                  "invert=%d rgb_order=%d",
             s_width, s_height, cfg->sclk_gpio, cfg->mosi_gpio, cfg->dc_gpio, cfg->rst_gpio, cfg->cs_gpio,
             cfg->bl_gpio, cfg->hz / 1000000, cfg->spi_mode, cfg->invert, cfg->rgb_order);
    return ESP_OK;
}

bool bsp_display_available(void)
{
    return s_ready;
}

int bsp_display_width(void)
{
    return s_width;
}

int bsp_display_height(void)
{
    return s_height;
}

// The back buffer, as an LGFX_Sprite. The ui component draws into it; nothing else
// should, and nothing outside bsp touches the panel itself.
void *bsp_display_canvas(void)
{
    return s_ready ? &s_canvas : nullptr;
}

void bsp_display_flush(void)
{
    if (s_ready) s_canvas.pushSprite(&s_lcd, 0, 0);
}

bool bsp_display_draw_jpeg(const uint8_t *jpeg, size_t len, int x, int y)
{
    if (!s_ready || !jpeg || !len) return false;
    return s_lcd.drawJpg(jpeg, len, x, y, s_width, s_height);
}

void bsp_display_clear(void)
{
    if (s_ready) s_lcd.fillScreen(TFT_BLACK);
}

// Straight to the panel, bypassing the back buffer: for proving the panel is alive
// before any of the UI exists.
void bsp_display_selftest(void)
{
    if (!s_ready) return;
    static const struct {
        const char *name;
        uint32_t color;
    } STEPS[] = {{"red", TFT_RED}, {"green", TFT_GREEN}, {"blue", TFT_BLUE}, {"white", TFT_WHITE}};

    for (auto &step : STEPS) {
        ESP_LOGW(TAG, "selftest: the whole panel should now be %s", step.name);
        s_lcd.fillScreen(step.color);
        vTaskDelay(pdMS_TO_TICKS(800));
    }
    s_lcd.fillScreen(TFT_BLACK);
    ESP_LOGW(TAG, "selftest done");
}

// Toggles each signal pin as a plain GPIO, high then low for three seconds, so a
// broken jumper can be found with a meter at the module end. Run before init.
void bsp_display_pinwalk(const bsp_display_config_t *cfg)
{
    const struct {
        const char *name;
        int gpio;
    } PINS[] = {
        {"SCL / clock", cfg->sclk_gpio}, {"SDA / data", cfg->mosi_gpio}, {"DC", cfg->dc_gpio},
        {"RES", cfg->rst_gpio},          {"BLK (control: known good)", cfg->bl_gpio},
    };

    for (auto &pin : PINS) {
        if (pin.gpio < 0) continue;
        gpio_config_t io = {};
        io.mode = GPIO_MODE_OUTPUT;
        io.pin_bit_mask = 1ULL << pin.gpio;
        gpio_config(&io);
        for (int level = 1; level >= 0; level--) {
            ESP_LOGW(TAG, "pinwalk: %s (GPIO%d) is %s for 3 s", pin.name, pin.gpio,
                     level ? "HIGH — expect 3.3 V" : "LOW — expect 0 V");
            gpio_set_level((gpio_num_t)pin.gpio, level);
            vTaskDelay(pdMS_TO_TICKS(3000));
        }
    }
    ESP_LOGW(TAG, "pinwalk done. Any pin that does not swing at the module end is the broken wire.");
}

void bsp_display_backlight(int percent)
{
    if (!s_has_backlight) return;
    s_backlight = percent < 0 ? 0 : (percent > 100 ? 100 : percent);
    ledc_set_duty(BL_MODE, BL_CHANNEL, (uint32_t)(s_backlight * 1023 / 100));
    ledc_update_duty(BL_MODE, BL_CHANNEL);
}

int bsp_display_backlight_get(void)
{
    return s_has_backlight ? s_backlight : -1;
}

} // extern "C"
