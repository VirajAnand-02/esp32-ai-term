#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    int status_led_gpio; // WS2812 status LED, -1 if not fitted
} bsp_config_t;

esp_err_t bsp_init(const bsp_config_t *cfg);

void bsp_log_chip_info(void);

// Sets the status LED colour; all zeros turns it off. No-op without an LED.
// The colour asked for is remembered unscaled, so a brightness change re-sends it.
void bsp_status_led_set(uint8_t r, uint8_t g, uint8_t b);
void bsp_status_led_get(uint8_t *r, uint8_t *g, uint8_t *b);

// A global 0-100 scale on everything the LED is asked to show. Applied inside
// bsp_status_led_set, so callers never have to know about it.
void bsp_status_led_brightness(int percent);
int bsp_status_led_brightness_get(void);

// Holds the LED dark without forgetting what it was showing, so the panel blanking
// on idle can take the LED with it and waking restores the same colour.
void bsp_status_led_blank(bool blank);
bool bsp_status_led_blanked(void);

// ─── microphone (I2S MEMS mic such as the INMP441) ────────────────────────

typedef struct {
    int bclk_gpio;
    int ws_gpio;
    int din_gpio;
    uint32_t sample_rate; // 0 → 16 kHz
    int gain_shift;       // 0 → 13; smaller is louder
} bsp_mic_config_t;

esp_err_t bsp_mic_init(const bsp_mic_config_t *cfg);
bool bsp_mic_available(void);
uint32_t bsp_mic_sample_rate(void);

// Gain can change while running (the dashboard pushes "mic_gain_shift" in the device config).
void bsp_mic_set_gain_shift(int shift);
int bsp_mic_gain_shift(void);

// How many samples hit the 16-bit rails since the last call; a clip that reports
// more than a percent or so is distorted and wants a higher gain shift.
uint32_t bsp_mic_clipped_reset(void);

// Enable the mic only while recording: the I2S clocks run the whole time it's on.
esp_err_t bsp_mic_start(void);
esp_err_t bsp_mic_stop(void);

// Reads up to `samples` 16-bit samples into dst (which must hold `samples` int32_t
// during conversion, i.e. samples * 4 bytes). Sets `read` to how many arrived.
esp_err_t bsp_mic_read(int16_t *dst, size_t samples, size_t *read, uint32_t timeout_ms);

// ─── speaker (I2S class-D amp such as the MAX98357A) ─────────────────

typedef struct {
    int bclk_gpio;
    int ws_gpio;   // LRC on the breakout
    int dout_gpio; // DIN on the breakout
    int sd_gpio;   // shutdown; -1 if tied high
    int sample_rate;
} bsp_speaker_config_t;

esp_err_t bsp_speaker_init(const bsp_speaker_config_t *cfg);
bool bsp_speaker_available(void);
uint32_t bsp_speaker_sample_rate(void); // the default; raw PCM may retune it

// The amp has no volume register, so this scales the samples: 0-100.
void bsp_speaker_set_volume(int percent);
int bsp_speaker_volume(void);

// Powers the amp up or down over its shutdown pin. Playback does this on its own;
// hold it on across a sequence of sounds to avoid a click between them.
void bsp_speaker_enable(bool on);
bool bsp_speaker_enabled(void);

// All three block until the audio has been played. `volume` of -1 uses the setting.
esp_err_t bsp_speaker_tone(int hz, int ms, int volume);
esp_err_t bsp_speaker_silence(int ms);
// Mono PCM at its own `rate`; the hardware is retuned to match rather than the
// audio being resampled. Pass 0 for the speaker's default rate.
esp_err_t bsp_speaker_write(const int16_t *pcm, size_t samples, int rate);

// Cuts short whatever is playing.
void bsp_speaker_stop(void);

// ── continuous playback, for video ────────────────────────────────────────
// bsp_speaker_write() retunes the clock and powers the amp down after every call,
// which clicks between chunks. A stream sets up once and stays open.

esp_err_t bsp_speaker_stream_begin(int rate);
esp_err_t bsp_speaker_stream_write(const int16_t *pcm, size_t samples);
void bsp_speaker_stream_end(void);
bool bsp_speaker_stream_active(void);

// Milliseconds of audio actually handed to the I2S hardware. i2s_channel_write blocks
// until DMA has room, so this advances at real playback speed and is the master clock
// video synchronises against.
uint32_t bsp_speaker_stream_clock_ms(void);

// ─── button ────────────────────────────────────────────────────────

typedef struct {
    int gpio;
    bool active_low; // true for a switch to GND, which enables the internal pull-up
    void (*on_press)(void *ctx);
    void (*on_release)(void *ctx, int held_ms);
    void *ctx;
} bsp_button_config_t;

// Debounced, polled on its own task, so the callbacks may do real work.
esp_err_t bsp_button_init(const bsp_button_config_t *cfg);
bool bsp_button_down(void);

// Fires a press and release as though the button had been used, for driving the
// device over a cable. `held_ms` is what the release reports.
void bsp_button_inject(int held_ms);

// Something is waiting to be read. A dark panel is normally a dark device, but with
// this set the LED keeps a dim amber alight through the blank instead of going out —
// the one exception the blanking was always going to need.
void bsp_status_led_notify(bool waiting);

// ─── power ───────────────────────────────────────────────────────────────
// Frequency scaling and automatic light sleep, as one switch.
//
// It is a switch rather than always-on because light sleep takes the USB-Serial-JTAG
// console with it. IDF has an option meant to prevent exactly that
// (CONFIG_USJ_NO_AUTO_LS_ON_CONNECTION, which holds a NO_LIGHT_SLEEP lock while a
// host is attached) and it does not survive tickless idle: the detection is a
// FreeRTOS tick hook looking for a USB SOF every tick, and once ticks start being
// skipped it stops seeing them, drops the lock, and the console goes dead while
// everything else carries on. Measured, not guessed — the device kept serving the
// websocket with nothing at all coming out of the cable.
//
// So: off by default, and off means the chip behaves exactly as it did before any of
// this existed — one fixed frequency, no sleep, a console that works.

esp_err_t bsp_power_init(void);

// true allows 80-240 MHz scaling and automatic light sleep. false pins the clock at
// maximum and never sleeps.
void bsp_power_allow_sleep(bool allow);
bool bsp_power_sleep_allowed(void);

// ─── navigation keys ───────────────────────────────────────────────
// The five-way switch plus a separate back button, polled together as one cluster:
// they are one input device as far as anything above this cares, and a second
// single-button driver instance would only duplicate the debouncing.

typedef enum {
    BSP_KEY_UP,
    BSP_KEY_DOWN,
    BSP_KEY_LEFT,
    BSP_KEY_RIGHT,
    BSP_KEY_OK,   // the five-way's centre press
    BSP_KEY_BACK, // its own button; back one level, and the launcher from the root
    BSP_KEY_COUNT,
} bsp_key_t;

typedef struct {
    bsp_key_t key;
    bool down; // false is the release
} bsp_key_event_t;

typedef struct {
    int gpio[BSP_KEY_COUNT]; // -1 for a key that is not fitted
    bool active_low;
    void (*on_key)(bsp_key_t key, bool down, void *ctx); // optional; runs on the poll task
    void *ctx;
} bsp_keys_config_t;

esp_err_t bsp_keys_init(const bsp_keys_config_t *cfg);
bool bsp_keys_available(void);

// Held right now. This is what a held direction wants: ask every frame rather than
// react to an edge, so holding right keeps turning a value up.
bool bsp_key_down(bsp_key_t key);

// One edge, oldest first. A tap shorter than a frame would be invisible to
// bsp_key_down, so presses are queued as well as latched. Returns false on timeout.
bool bsp_keys_wait(bsp_key_event_t *out, uint32_t timeout_ms);
void bsp_keys_flush(void); // drop queued edges, e.g. on entering a screen

// Queues a tap as though the switch had been pressed. For driving the interface
// over a cable — a board on a bench has no fingers.
void bsp_keys_inject(bsp_key_t key);

// Drives the key's pin low for `hold_ms` and lets go, which is electrically what
// the switch does. Unlike bsp_keys_inject this goes through the real path — the
// interrupt, the debounce, the queue — so it is the only way to check that path
// without a finger. Safe because the pin is only ever pulled down, never driven
// against a closed contact. Returns false if there is no such key.
bool bsp_keys_press_pin(bsp_key_t key, int hold_ms);

const char *bsp_key_name(bsp_key_t key);

// ─── display (ST7789 over SPI, driven by LovyanGFX) ───────────────────────

typedef struct {
    int sclk_gpio;
    int mosi_gpio;
    int rst_gpio;   // -1 if tied high
    int dc_gpio;
    int cs_gpio;    // -1 on the 7-pin modules, which ground CS on the board
    int bl_gpio;    // -1 when the backlight is not switchable
    int brightness; // 0-100 to come up at; <= 0 means full
    int width;      // 0 → 240
    int height;     // 0 → 240
    int hz;         // SPI write clock
    int spi_mode;   // 3 for this panel; mode 0 leaves it blank
    bool invert;    // most 240x240 IPS panels need this on
    bool rgb_order; // flip if red and blue come out swapped
    int x_gap;      // window offset, for panels whose glass sits inside a bigger controller
    int y_gap;
} bsp_display_config_t;

esp_err_t bsp_display_init(const bsp_display_config_t *cfg);
bool bsp_display_available(void);
int bsp_display_width(void);
int bsp_display_height(void);

// The back buffer, an LGFX_Sprite. Everything is composed here and pushed in one
// transfer, so animation neither tears nor flickers. Only the ui component draws.
void *bsp_display_canvas(void);
void bsp_display_flush(void);

// Decodes a baseline JPEG straight onto the panel, bypassing the back buffer.
// ~30% faster than decoding into the canvas and pushing it, so this is the path
// video uses. Tearing is possible, which is why the UI still goes through the
// canvas; at video frame rates it is not noticeable.
// Drawn at (x, y) at its natural size. A frame smaller than the panel is placed,
// never scaled up: scaling would push the full 240x240 over SPI again and give
// back the whole saving of sending something smaller.
bool bsp_display_draw_jpeg(const uint8_t *jpeg, size_t len, int x, int y);

void bsp_display_clear(void);

// Diagnostics, for a panel that will not light up.
void bsp_display_selftest(void);                         // solid colours, straight to the panel
void bsp_display_pinwalk(const bsp_display_config_t *cfg); // wiggle each pin; run before init

void bsp_display_backlight(int percent);
int bsp_display_backlight_get(void); // -1 when there is no backlight control

#ifdef __cplusplus
}
#endif
