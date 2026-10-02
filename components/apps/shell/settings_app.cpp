#include "shell_internal.hpp"

#include <stdio.h>

#include "net_wifi.h"
#include "settings.h"

// The settings list. Left and right change the selected value and it applies at
// once — brightness especially, because a brightness control you cannot see the
// effect of until you confirm is useless.

namespace shell {
namespace {

int sel;
int top;

// Rows after the generic ones. The spec table is integers and bools only, and a
// list of networks is neither, so the wi-fi page is appended here rather than
// growing setting_spec_t with a "this one opens a screen" field. diag_app does the
// same thing with its two fixed rows.
constexpr int EXTRA_ROWS = 1;

int rows()
{
    return settings_visible_count() + EXTRA_ROWS;
}

bool is_extra(int i)
{
    return i >= settings_visible_count();
}

void enter(void *)
{
    sel = 0;
    top = 0;
}

void leave(void *)
{
    // Commit now rather than waiting out the debounce: leaving the screen is the
    // clearest "I am done" there is, and a power cut a second later should not
    // lose the change.
    settings_flush();
}

void value_text(setting_id_t id, char *out, size_t n)
{
    const setting_spec_t *sp = settings_spec(id);
    const int v = settings_get(id);
    if (sp->is_bool) {
        snprintf(out, n, "%s", v ? "on" : "off");
    } else if (v == 0 && sp->unit[0] == 's') {
        // A zero timeout is "never", which is what it means; "0s" reads as instant.
        snprintf(out, n, "never");
    } else {
        snprintf(out, n, "%d%s", v, sp->unit);
    }
}

void input(void *, const ui_input_t *in)
{
    const int64_t t = now_ms();
    if (in->pressed[BSP_KEY_BACK]) {
        ui_pop();
        return;
    }
    const int n = rows();
    sel = move_sel(sel, n, in);
    top = scroll_to(sel, top, n);

    if (is_extra(sel)) {
        if (in->pressed[BSP_KEY_OK]) ui_push(&wifi_app);
        return;
    }

    const setting_id_t id = settings_visible_at(sel);
    const setting_spec_t *sp = settings_spec(id);

    if (sp->is_bool) {
        if (in->pressed[BSP_KEY_OK] || in->pressed[BSP_KEY_LEFT] || in->pressed[BSP_KEY_RIGHT]) {
            settings_set(id, settings_get(id) ? 0 : 1);
        }
        return;
    }
    if (repeating(BSP_KEY_LEFT, in, t)) settings_set(id, settings_get(id) - sp->step);
    if (repeating(BSP_KEY_RIGHT, in, t)) settings_set(id, settings_get(id) + sp->step);
}

void paint(void *, void *, int64_t)
{
    title("settings");
    char value[16];
    const int n = rows();
    for (int i = top; i < n && i < top + ROWS_VISIBLE; i++) {
        const int y = LIST_TOP + (i - top) * ROW_H;
        if (is_extra(i)) {
            list_row(y, "wi-fi", net_wifi_state() == NET_WIFI_CONNECTED ? net_wifi_ssid() : "not connected", i == sel);
            continue;
        }
        const setting_id_t id = settings_visible_at(i);
        value_text(id, value, sizeof(value));
        list_row(y, settings_spec(id)->label, value, i == sel);
    }
    scrollbar(top, n);

    if (is_extra(sel)) {
        hint("ok opens  ·  back saves");
        return;
    }

    // A bar under the selected row, so a percentage has a shape as well as a number.
    const setting_id_t selected = settings_visible_at(sel);
    const setting_spec_t *sp = settings_spec(selected);
    if (!sp->is_bool) {
        const int span = sp->max - sp->min;
        const int y = LIST_TOP + (sel - top) * ROW_H + 19;
        const int w = cv->width() - 36;
        const int filled = span > 0 ? w * (settings_get(selected) - sp->min) / span : 0;
        cv->fillRect(18, y, w, 2, dim(AMBER, 0.15f));
        cv->fillRect(18, y, filled, 2, PHOS_DIM);
    }
    hint(sp->is_bool ? "ok toggles  ·  back saves" : "left/right adjust  ·  back saves");
}

} // namespace

const ui_app_t settings_app = {"settings", enter, input, paint, leave, nullptr};

} // namespace shell
