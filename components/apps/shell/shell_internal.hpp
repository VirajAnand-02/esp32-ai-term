#pragma once

#include "ui.h"
#include "ui_draw.hpp"

// Shared between the launcher and its apps. Everything here draws through the ui's
// render task, so none of it may block.

namespace shell {

using namespace uidraw;

// Where a list starts and how far apart its rows sit. One place, so the launcher,
// the settings list and the diagnostics menu all line up.
constexpr int LIST_TOP = 52;
constexpr int ROW_H = 30;
constexpr int ROWS_VISIBLE = 5; // 52 + 5*30 = 202, which clears the hint line

// A held direction starts repeating after this, then steps once a frame. Without it
// a 5-step brightness row takes twenty separate presses.
constexpr int REPEAT_DELAY_MS = 400;

void title(const char *text);
void hint(const char *text);

// Keeps `top` such that `sel` is on screen, and returns it.
int scroll_to(int sel, int top, int count);
void scrollbar(int top, int count);

// Up/down with wrap. Returns the new selection.
int move_sel(int sel, int count, const ui_input_t *in);

// True when a direction should act this frame: once on the press, then repeatedly
// once it has been held past the delay.
bool repeating(bsp_key_t key, const ui_input_t *in, int64_t t);

extern const ui_app_t settings_app;
extern const ui_app_t sounds_app;
extern const ui_app_t diag_app;
extern const ui_app_t keytest_app;
extern const ui_app_t clock_app;
extern const ui_app_t timer_app;
extern const ui_app_t alarms_app;
extern const ui_app_t stopwatch_app;
extern const ui_app_t pomodoro_app;
extern const ui_app_t dashboard_app;
extern const ui_app_t notes_app;
extern const ui_app_t notify_app;
extern const ui_app_t wifi_app;
extern const ui_app_t todo_app;

// Loads the todo list from NVS. Called by shell_init before anything can paint it.
void todo_init();

// What the dashboard needs to know about a pomodoro without owning one.
bool pomodoro_running();
bool pomodoro_paused();
const char *pomodoro_stage_name();
int pomodoro_seconds_left();
int pomodoro_round(); // 1..4 within the current cycle

} // namespace shell
