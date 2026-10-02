#include "shell_internal.hpp"

#include <stdio.h>

#include "settings.h"
#include "sounds.h"

// The sound bank, playable. Worth having on its own now that the amplifier runs off
// the battery and no longer browns out: it is the quickest way to hear whether the
// speaker is behaving, and volume is adjustable from the same screen.

namespace shell {
namespace {

int sel;
int top;
int playing = -1; // the row that was last triggered, for a moment of feedback
int64_t played_at;

void enter(void *)
{
    sel = 0;
    top = 0;
    playing = -1;
}

void input(void *, const ui_input_t *in)
{
    const int64_t t = now_ms();
    if (in->pressed[BSP_KEY_BACK]) {
        ui_pop();
        return;
    }
    sel = move_sel(sel, SOUNDS_COUNT, in);
    top = scroll_to(sel, top, SOUNDS_COUNT);

    // Volume from here as well as from settings: adjusting it while listening is
    // the only way to judge it.
    const setting_spec_t *sp = settings_spec(SET_VOLUME);
    if (repeating(BSP_KEY_LEFT, in, t)) settings_set(SET_VOLUME, settings_get(SET_VOLUME) - sp->step);
    if (repeating(BSP_KEY_RIGHT, in, t)) settings_set(SET_VOLUME, settings_get(SET_VOLUME) + sp->step);

    if (in->pressed[BSP_KEY_OK]) {
        playing = sel;
        played_at = t;
        // sounds_play blocks until the sound has finished, so this frame runs long.
        // Acceptable here: the screen is a list, and the point of pressing was the
        // sound rather than the animation.
        sounds_play(sounds_name(sel), -1);
    }
}

void paint(void *, void *, int64_t t)
{
    title("sounds");
    for (int i = top; i < SOUNDS_COUNT && i < top + ROWS_VISIBLE; i++) {
        const char *name = sounds_name(i);
        if (!name) break;
        const int y = LIST_TOP + (i - top) * ROW_H;
        const bool recent = i == playing && t - played_at < 600;
        list_row(y, name, recent ? "playing" : nullptr, i == sel);
    }
    scrollbar(top, SOUNDS_COUNT);

    char vol[24];
    snprintf(vol, sizeof(vol), "volume %d%%", settings_get(SET_VOLUME));
    text_centered(vol, 200, AMBER_DIM);
    hint("ok plays  ·  left/right volume");
}

} // namespace

const ui_app_t sounds_app = {"sounds", enter, input, paint, nullptr, nullptr};

} // namespace shell
