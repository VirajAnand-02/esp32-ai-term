#include "shell_internal.hpp"

#include <stdio.h>

#include "notes.h"

// The voice notes, playable on the terminal itself.
//
// The clips live on the server, so this is a list of what it has and a transport for
// whichever one is playing. Seeking asks the server to restart the stream somewhere
// else rather than buffering a whole note on a device that has nowhere to put one.

namespace shell {
namespace {

constexpr int SEEK_MS = 5000;

int sel;
int top;

void enter(void *)
{
    sel = 0;
    top = 0;
    notes_refresh();
}

void leave(void *)
{
    // Leaving the screen stops the note. Carrying on playing from a list you can no
    // longer see, with no way to stop it, would be worse than losing your place.
    notes_stop();
}

void input(void *, const ui_input_t *in)
{
    if (in->pressed[BSP_KEY_BACK]) {
        ui_pop();
        return;
    }
    const int count = notes_count();

    if (notes_playing()) {
        if (in->pressed[BSP_KEY_OK]) notes_pause(!notes_paused());
        if (in->pressed[BSP_KEY_LEFT]) {
            const int at = notes_position_ms() - SEEK_MS;
            notes_play(notes_current(), at > 0 ? at : 0);
        }
        if (in->pressed[BSP_KEY_RIGHT]) notes_play(notes_current(), notes_position_ms() + SEEK_MS);
        if (in->pressed[BSP_KEY_UP] || in->pressed[BSP_KEY_DOWN]) notes_stop();
        return;
    }

    sel = move_sel(sel, count, in);
    top = scroll_to(sel, top, count);
    if (in->pressed[BSP_KEY_OK] && count) {
        const note_entry_t *e = notes_at(sel);
        if (e) notes_play(e->id, 0);
    }
}

void paint(void *, void *, int64_t t)
{
    title("voice notes");

    if (notes_playing()) {
        const int pos = notes_position_ms();
        const int len = notes_length_ms();
        char buf[32];
        snprintf(buf, sizeof(buf), "%d:%02d", pos / 60000, (pos / 1000) % 60);
        cv->setFont(&fonts::FreeMonoBold18pt7b);
        cv->setTextColor(notes_paused() ? AMBER_DIM : PHOS);
        cv->drawString(buf, (cv->width() - cv->textWidth(buf)) / 2, 84);

        small();
        snprintf(buf, sizeof(buf), "of %d:%02d", len / 60000, (len / 1000) % 60);
        text_centered(buf, 128, AMBER_DIM);

        const int w = cv->width() - 60;
        const float frac = len > 0 ? (float)pos / (float)len : 0.0f;
        cv->fillRect(30, 154, w, 3, dim(AMBER, 0.15f));
        cv->fillRect(30, 154, (int)(w * (frac > 1.0f ? 1.0f : frac)), 3, notes_paused() ? AMBER_DIM : PHOS_DIM);

        if (notes_paused()) text_centered("paused", 178, AMBER);
        hint("ok pauses  ·  left/right 5s");
        return;
    }

    const int count = notes_count();
    if (!notes_listed()) {
        small();
        text_centered("asking the server..", 110, AMBER_FAINT);
        hint("back leaves");
        return;
    }
    if (!count) {
        small();
        text_centered("no voice notes yet", 100, AMBER_DIM);
        text_centered("double tap the mic", 126, AMBER_FAINT);
        text_centered("button to record one", 146, AMBER_FAINT);
        hint("back leaves");
        return;
    }

    char len[16];
    for (int i = top; i < count && i < top + ROWS_VISIBLE; i++) {
        const note_entry_t *e = notes_at(i);
        if (!e) break;
        const int secs = (int)e->seconds;
        snprintf(len, sizeof(len), "%d:%02d", secs / 60, secs % 60);
        list_row(LIST_TOP + (i - top) * ROW_H, e->at[0] ? e->at : e->id, len, i == sel);
    }
    scrollbar(top, count);
    hint("ok plays  ·  back leaves");
}

} // namespace

const ui_app_t notes_app = {"voice notes", enter, input, paint, leave, nullptr};

} // namespace shell
