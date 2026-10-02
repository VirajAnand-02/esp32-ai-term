#include "shell_internal.hpp"

#include <string.h>

#include "esp_log.h"
#include "shell.h"

namespace shell {
namespace {

// ── shared list furniture ─────────────────────────────────────────────────

int64_t held_since[BSP_KEY_COUNT];

} // namespace

void title(const char *text)
{
    large();
    text_centered(text, 10, AMBER);
    cv->drawFastHLine(14, 38, cv->width() - 28, AMBER_FAINT);
    small();
}

void hint(const char *text)
{
    small();
    text_centered(text, 216, AMBER_FAINT);
}

int scroll_to(int sel, int top, int count)
{
    if (count <= ROWS_VISIBLE) return 0;
    if (sel < top) top = sel;
    if (sel >= top + ROWS_VISIBLE) top = sel - ROWS_VISIBLE + 1;
    if (top > count - ROWS_VISIBLE) top = count - ROWS_VISIBLE;
    if (top < 0) top = 0;
    return top;
}

// A thumb down the right edge, so a list longer than the screen says so rather
// than just appearing to end.
void scrollbar(int top, int count)
{
    if (count <= ROWS_VISIBLE) return;
    const int track_y = LIST_TOP - 4;
    const int track_h = ROWS_VISIBLE * ROW_H;
    const int x = cv->width() - 5;
    cv->fillRect(x, track_y, 2, track_h, dim(AMBER, 0.12f));
    const int thumb_h = track_h * ROWS_VISIBLE / count;
    const int thumb_y = track_y + track_h * top / count;
    cv->fillRect(x, thumb_y, 2, thumb_h < 8 ? 8 : thumb_h, AMBER_DIM);
}

int move_sel(int sel, int count, const ui_input_t *in)
{
    if (count <= 0) return 0;
    if (in->pressed[BSP_KEY_UP]) sel = (sel + count - 1) % count;
    if (in->pressed[BSP_KEY_DOWN]) sel = (sel + 1) % count;
    return sel;
}

bool repeating(bsp_key_t key, const ui_input_t *in, int64_t t)
{
    if (in->pressed[key]) {
        held_since[key] = t;
        return true;
    }
    if (!in->held[key]) {
        held_since[key] = 0;
        return false;
    }
    // Held: nothing until the delay has passed, then every frame.
    return held_since[key] != 0 && t - held_since[key] >= REPEAT_DELAY_MS;
}

// ── the launcher ──────────────────────────────────────────────────────────

namespace {

struct entry_t {
    const char *name;
    const char *blurb;
    const ui_app_t *app; // null means "this is the terminal": pop everything
};

const entry_t ENTRIES[] = {
    {"terminal", "chat, voice, tools", nullptr},
    {"clock", "the time, and what is due", &clock_app},
    {"timer", "count down to a noise", &timer_app},
    {"pomodoro", "focus, break, repeat", &pomodoro_app},
    {"alarms", "wake up, or be reminded", &alarms_app},
    {"todos", "daily, and everything else", &todo_app},
    {"stopwatch", "count up, mark a lap", &stopwatch_app},
    {"settings", "brightness, sound, power", &settings_app},
    {"voice notes", "play back what you recorded", &notes_app},
    {"sounds", "play the built-in bank", &sounds_app},
    {"diagnostics", "what this board is doing", &diag_app},
};
constexpr int COUNT = (int)(sizeof(ENTRIES) / sizeof(ENTRIES[0]));

int sel;
int top;

void launcher_enter(void *)
{
    sel = 0;
    top = 0;
}

void launcher_input(void *, const ui_input_t *in)
{
    // Back from the launcher is back to the terminal: it is the root of the shell,
    // not a dead end.
    if (in->pressed[BSP_KEY_BACK]) {
        ui_pop_all();
        return;
    }
    sel = move_sel(sel, COUNT, in);
    top = scroll_to(sel, top, COUNT);
    if (in->pressed[BSP_KEY_OK]) {
        if (ENTRIES[sel].app) ui_push(ENTRIES[sel].app);
        else ui_pop_all();
    }
}

void launcher_paint(void *, void *, int64_t)
{
    title("AI-TERM");
    for (int i = top; i < COUNT && i < top + ROWS_VISIBLE; i++) {
        const int y = LIST_TOP + (i - top) * ROW_H;
        const bool on = i == sel;
        list_row(y, ENTRIES[i].name, nullptr, on);
        if (on) {
            // The blurb only under the selection: four of them at once is a wall of
            // small text, and only one of them is being considered.
            cv->setTextColor(AMBER_FAINT);
            cv->drawString(fit(ENTRIES[i].blurb, cv->width() - 40), 18, y + 14);
        }
    }
    scrollbar(top, COUNT);
    hint("ok opens  ·  back exits");
}

const ui_app_t launcher = {"launcher", launcher_enter, launcher_input, launcher_paint, nullptr, nullptr};

} // namespace
} // namespace shell

extern "C" void shell_init(void)
{
    shell::todo_init();
    ui_set_home(&shell::launcher);
    ui_set_dashboard(&shell::dashboard_app);
    ui_set_drawer(&shell::notify_app);
    ui_set_right(&shell::todo_app);
    ESP_LOGI("shell", "launcher registered as home");
}
