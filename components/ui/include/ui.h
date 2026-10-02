#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "bsp.h"
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

// Everything drawn on the terminal's panel. One render task composes frames into
// the bsp back buffer at a steady rate; the calls below only set what it should be
// showing, so none of them block and none of them touch the display.

typedef enum {
    UI_TONE_AMBER,
    UI_TONE_GREEN,
    UI_TONE_RED,
    UI_TONE_BLUE,
    UI_TONE_DIM,
} ui_tone_t;

// What is on the panel right now, for device_status and for debugging: the screen
// name, and whether a display tool is holding it against the reply text.
const char *ui_screen(void);
bool ui_is_held(void);

// Starts the render task. bsp_display_init must have succeeded; without a panel
// every call below is a no-op, so the app never has to check.
esp_err_t ui_start(void);

// ── the backlight ─────────────────────────────────────────────────────────
// Driven from here rather than straight from settings, because the ui is what
// dims it when nothing has happened for a while. ui_set_brightness sets the level
// it rests at; the idle timer scales that, so the two never fight.

void ui_set_brightness(int percent);
int ui_brightness(void);

// Seconds of no activity before the panel dims, and before it goes dark. 0 for
// never. Anything the user does calls ui_note_activity() and brings it back.
void ui_set_idle_dim(int dim_after_s, int blank_after_s);
void ui_note_activity(void);

// ── screens on top of the terminal ────────────────────────────────────────
// The launcher and its apps are drawn by the render task, not by a task of their
// own. That is the whole point: there is exactly one writer to the panel, so an
// app can never tear against an incoming image the way the games component could.
//
// An app supplies input and paint; the compositor handles the keys, the frame
// pacing and the flush, and pops the whole stack whenever the terminal has
// something of its own to say.

typedef struct {
    bool pressed[BSP_KEY_COUNT]; // went down this frame
    bool held[BSP_KEY_COUNT];    // down right now, for a key that repeats
} ui_input_t;

typedef struct {
    const char *name;
    void (*enter)(void *ctx);
    void (*input)(void *ctx, const ui_input_t *in);
    void (*paint)(void *ctx, void *canvas, int64_t t); // canvas is an LGFX_Sprite *
    void (*exit)(void *ctx);
    void *ctx;
} ui_app_t;

void ui_push(const ui_app_t *app);
void ui_pop(void);
void ui_pop_all(void); // back to the terminal
int ui_depth(void);

// What the back key opens when nothing is on the stack. Registering it here keeps
// the ui from having to know what a launcher is.
void ui_set_home(const ui_app_t *app);
void ui_go_home(void); // open it from somewhere that is not the back key

// What the terminal shows when it is idle. Only `paint` is used: keys still do
// what they do everywhere else, so back opens the launcher from here as well.
// Registering it keeps the ui from needing to know what a clock or a pomodoro is.
void ui_set_dashboard(const ui_app_t *app);

// Pulled down with the down key from the dashboard, like a drawer. Registered here
// rather than handled by the dashboard itself because the dashboard is only a
// painter — the render task never asks it about keys.
void ui_set_drawer(const ui_app_t *app);

// Opened with the right key from the dashboard, the same arrangement as the drawer
// and for the same reason: the dashboard paints but never sees a key.
void ui_set_right(const ui_app_t *app);

// The link line, for a dashboard that wants to show it.
const char *ui_link_state(void);
const char *ui_ip(void);

// True while the video player is writing straight to the glass. Nothing may open
// over it; whoever wants the screen has to stop the video first.
bool ui_exclusive(void);

// ── what the terminal is doing ────────────────────────────────────────────

void ui_boot(const char *step);                         // boot screen, naming the current step
void ui_link(const char *state, const char *ip);        // idle screen: link state and address
void ui_prompt(const char *text, const char *origin);   // a question arrived
// The first chunk of an answer, or the first tool of one, clears the answer before it:
// each response replaces the last rather than running on from it.
void ui_reply_append(const char *chunk);
void ui_reply_done(bool aborted, int in_tokens, int out_tokens);
void ui_working(const char *tool);                      // a tool is running; NULL when it ends
void ui_error(const char *msg);

// Something worth saying that is not a failure — "nothing was said" after a mic
// press that caught only silence, say. Amber rather than red, shorter on screen,
// and it does not pull you out of a screen you deliberately opened.
void ui_notice(const char *msg);
void ui_listening(int seconds);      // recording started; seconds <= 0 means hold-to-talk
void ui_sending(void);               // the clip is on its way up to be transcribed
// Relabels the sending splash as the turn moves on: "running agent", then each tool
// by name. `detail` is the small second line. Does not change which screen is up.
void ui_stage(const char *label, const char *detail);
void ui_level(float level);                             // 0..1, live from the microphone
void ui_listening_done(void);

// Back during a recording means "up one level", and up one level from recording is
// not recording. The interface has no idea what a recorder is, so whoever owns one
// registers the abort here. Only the back key does this: ok is how a hands-free
// note is stopped and kept.
typedef void (*ui_cancel_cb_t)(void);
void ui_on_cancel(ui_cancel_cb_t cb);

// ── the display_* tools, which take the panel over ────────────────────────
// Whatever they draw stays until the back key, ui_raw_release(), or the terminal
// having something of its own to say.

void ui_raw_message(const char *title, const char *body, ui_tone_t tone, int scale);
void ui_raw_fill(uint8_t r, uint8_t g, uint8_t b);
bool ui_raw_pattern(const char *name); // "bars", "grid" or "gradient"; false if unknown

// A JPEG the server has already cropped and scaled to the panel. Returns false if
// it will not decode.
bool ui_raw_image(const uint8_t *jpeg, size_t len);

// ── video ─────────────────────────────────────────────────────────────────
// The player owns the panel outright while it runs: the render loop stops, and
// each frame is decoded straight to the glass rather than through the canvas.

void ui_take_panel(void);
void ui_give_panel(void);
bool ui_video_present(const uint8_t *jpeg, size_t len, int x, int y);
void ui_raw_release(void);

#ifdef __cplusplus
}
#endif
