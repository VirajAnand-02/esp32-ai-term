#include "shell_internal.hpp"

#include <stdio.h>
#include <string.h>

#include "aiclock.h"
#include "notify.h"

// The notification drawer: pulled down with the down key from the dashboard, which
// is the one gesture on that screen that was not already spoken for.
//
// An ordinary pushed app rather than an overlay, so it gets the key routing, the
// back behaviour and the idle dimming that every other screen already has, and the
// dashboard stays the painter-only screen its own comment promises.

namespace shell {
namespace {

int sel;
int top;
// Which entry is open full-screen, or -1 for the list. A one-line body fits in the
// row, but the server's notices and an alarm's description often do not.
int open_at = -1;

// "7:42 pm", or how long ago when the clock was not set at the time.
void when(const notify_entry_t *e, char *out, size_t n)
{
    if (!e->at) {
        strlcpy(out, "--", n);
        return;
    }
    struct tm tm;
    localtime_r(&e->at, &tm);
    aiclock_format_hm(tm.tm_hour, tm.tm_min, out, n);
}

void enter(void *)
{
    sel = 0;
    top = 0;
    open_at = -1;
}

// Everything here has been seen by the time the drawer closes, which is the whole
// definition of read.
void leave(void *)
{
    notify_mark_all_read();
}

void input(void *, const ui_input_t *in)
{
    const int count = notify_count();

    if (in->pressed[BSP_KEY_BACK]) {
        if (open_at >= 0) open_at = -1; // back out of the entry, not the drawer
        else ui_pop();
        return;
    }
    if (open_at >= 0) return; // nothing else to do while reading one

    sel = move_sel(sel, count, in);
    top = scroll_to(sel, top, count);
    if (in->pressed[BSP_KEY_OK] && count) open_at = sel;
}

void paint(void *, void *, int64_t)
{
    const int count = notify_count();

    if (open_at >= 0) {
        const notify_entry_t *e = notify_at(open_at);
        if (!e) {
            open_at = -1;
            return;
        }
        title(e->title);
        char at[16];
        when(e, at, sizeof(at));
        text_centered(at, 44, AMBER_FAINT);
        small();
        // Wrapped rather than fitted: a notice or an alarm's description is usually
        // longer than the twenty characters one line holds.
        text_block(e->body, 10, 70, cv->width() - 20, 206, FG, 20);
        hint("back returns to the list");
        return;
    }

    title("notifications");
    if (!count) {
        text_centered("nothing missed", 110, AMBER_DIM);
        hint("down from the home screen opens this");
        return;
    }

    for (int i = top; i < count && i < top + ROWS_VISIBLE; i++) {
        const notify_entry_t *e = notify_at(i);
        if (!e) break;
        char at[16];
        when(e, at, sizeof(at));
        // An unread one is marked rather than coloured differently: the selected row
        // already owns the colour change.
        char label[NOTIFY_TITLE + 4];
        snprintf(label, sizeof(label), "%s%s", e->read ? "" : "* ", e->title);
        list_row(LIST_TOP + (i - top) * ROW_H, label, at, i == sel);
    }
    scrollbar(top, count);
    hint("ok reads it  ·  back closes");
}

} // namespace

const ui_app_t notify_app = {"notifications", enter, input, paint, leave, nullptr};

} // namespace shell
