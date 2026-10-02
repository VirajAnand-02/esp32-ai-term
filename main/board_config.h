#pragma once

// All board wiring lives here. Components receive these values through
// their init config structs and never hard-code pins themselves.

// ESP32-S3-DevKitC-1 onboard WS2812 RGB LED: GPIO48 on v1.0, GPIO38 on v1.1.
#define BOARD_STATUS_LED_GPIO 48

// ─── INMP441 I2S microphone ───────────────────────────────────────────────
// VDD→3V3, GND→GND, L/R→GND (left channel), SCK→GPIO5, WS→GPIO4, SD→GPIO6.
#define BOARD_MIC_BCLK_GPIO 5
#define BOARD_MIC_WS_GPIO   4
#define BOARD_MIC_DIN_GPIO  6

// The INMP441's gain shift, the speaker volume and the backlight level are no
// longer here: they are settings now, and their defaults and ranges live in one
// table in components/settings/settings.c. Keeping a second copy here is exactly
// how the two drifted apart before.

// ─── ST7789 240x240 SPI display ───────────────────────────────────────────
// VCC→3V3, GND→GND, SCL→GPIO12, SDA→GPIO11, RES→GPIO14, DC→GPIO13, BLK→GPIO21.
#define BOARD_LCD_SCLK_GPIO 12
#define BOARD_LCD_MOSI_GPIO 11
#define BOARD_LCD_RST_GPIO  14
#define BOARD_LCD_DC_GPIO   13
#define BOARD_LCD_BL_GPIO   21
#define BOARD_LCD_WIDTH     240
#define BOARD_LCD_HEIGHT    240
#define BOARD_LCD_CS_GPIO   -1  // the 7-pin module has no CS line; it is grounded on the board
// The SPI clock is 80 MHz divided by an integer, so the only real steps are
// 40, 26.67, 20 and 16 MHz; anything else snaps to one of these. Both 40 MHz and
// 26.67 MHz were tried on this panel and both visibly corrupted the picture, so
// 20 MHz is not a conservative default here, it is the measured limit. Do not
// raise it without re-running /soak and looking at the glass.
#define BOARD_LCD_HZ        (20 * 1000 * 1000)
#define BOARD_LCD_SPI_MODE  3  // mode 0 leaves this panel blank
#define BOARD_LCD_INVERT    true
#define BOARD_LCD_RGB_ORDER false  // flip if red and blue come out swapped
#define BOARD_LCD_X_GAP     0
#define BOARD_LCD_Y_GAP     0
// Diagnostics for a panel that will not light up; both off for normal boots.
// SELFTEST paints solid red/green/blue/white straight to the panel, bypassing the
// UI. PINWALK toggles each signal pin as a plain GPIO so a broken jumper can be
// found with a meter at the module end; it runs before the panel is initialised.
#define BOARD_LCD_SELFTEST  0
#define BOARD_LCD_PINWALK   0

// ─── push-to-talk button ─────────────────────────────────────────
// A momentary switch between GPIO9 and GND; the internal pull-up does the rest.
// Hold it to speak, let go to send.
#define BOARD_BUTTON_GPIO       9
#define BOARD_BUTTON_ACTIVE_LOW true
// Anything shorter than this is a stray knock, not speech.
#define BOARD_BUTTON_MIN_MS     300

// ─── navigation keys ─────────────────────────────────────────────
// The five-way switch plus a separate back button. Each contact goes to GND and the
// internal pull-ups do the rest, exactly like the talk button.
//
// 39-42 are the ESP32-S3's pin-based JTAG (MTCK/MTDO/MTDI/MTMS). They are free to
// use as ordinary GPIO here because debugging goes over USB-Serial-JTAG instead —
// worth knowing before anyone tries to attach a hardware probe.
//
// The four directions are the pins as *measured*, not as the module is labelled.
// Wired in the obvious order (up=39, down=40, left=41, right=42) the axes came out
// swapped — up read as right, left as down — so they run 42, 41, 40, 39 instead.
// Diagnostics → key test shows the truth; check there before changing them back.
#define BOARD_KEY_UP_GPIO    42
#define BOARD_KEY_DOWN_GPIO  41
#define BOARD_KEY_LEFT_GPIO  40
#define BOARD_KEY_RIGHT_GPIO 39
#define BOARD_KEY_OK_GPIO    17
#define BOARD_KEY_BACK_GPIO  47
#define BOARD_KEYS_ACTIVE_LOW true

// ─── MAX98357A I2S amplifier ────────────────────────────────────
// VIN→5V, GND→GND, BCLK→GPIO15, LRC→GPIO16, DIN→GPIO7, SD→GPIO18.
// SD is the amp's shutdown line, held low between sounds so it does not hiss.
#define BOARD_SPK_BCLK_GPIO 15
#define BOARD_SPK_WS_GPIO   16
#define BOARD_SPK_DOUT_GPIO 7
#define BOARD_SPK_SD_GPIO   18
// Tones are generated in software, so this is what sets their quality: at 16 kHz
// a 5 kHz sine is barely three samples a cycle and sounds gritty. Recorded audio
// is unaffected, since bsp_speaker_write retunes the clock to the clip's own rate.
#define BOARD_SPK_RATE      44100

