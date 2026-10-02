#include "shell_internal.hpp"
#include "text_entry.hpp"

#include <stdio.h>
#include <string.h>

#include "net_wifi.h"
#include "wifi_store.h"

// Wi-Fi, from the panel.
//
// Until this existed the network was a #define in wifi_credentials.h: taking the
// terminal anywhere else meant a rebuild and a cable. Two screens — what is saved,
// and what is in range — plus the character picker for the password.

namespace shell {
namespace {

// Feedback stays on this screen rather than going through ui_notice, which is for
// the terminal's own screens and now waits until an app has closed before showing
// anything. A delayed "saved" three screens later is worse than none.
char toast[28];
int64_t toast_at;

void say(const char *msg)
{
    strlcpy(toast, msg, sizeof(toast));
    toast_at = now_ms();
}

void draw_toast()
{
    if (!toast[0]) return;
    if (now_ms() - toast_at > 1800) {
        toast[0] = '\0';
        return;
    }
    text_centered(toast, 216, PHOS);
}

// ── the saved list ────────────────────────────────────────────────────────

int sel;
int top;

// One extra row under the saved networks, for adding another.
constexpr int EXTRA_ROWS = 1;

int rows()
{
    return wifi_store_count() + EXTRA_ROWS;
}

void open_scan();

void saved_enter(void *)
{
    sel = 0;
    top = 0;
    toast[0] = '\0';
}

void saved_input(void *, const ui_input_t *in)
{
    if (in->pressed[BSP_KEY_BACK]) {
        ui_pop();
        return;
    }

    // Forget is on right rather than on ok, because ok on a list means "open this"
    // everywhere else and deleting a network by accident is annoying to undo.
    if (in->pressed[BSP_KEY_RIGHT] && sel < wifi_store_count()) {
        const wifi_saved_t *e = wifi_store_at(sel);
        if (e) {
            char ssid[WIFI_SSID_LEN];
            strlcpy(ssid, e->ssid, sizeof(ssid));
            wifi_store_forget(ssid);
            // Forgetting is about next time: the link we are on stays up until it
            // drops of its own accord.
            say("forgotten");
        }
        if (sel >= rows()) sel = rows() - 1;
        if (sel < 0) sel = 0;
        return;
    }

    const int count = rows();
    sel = move_sel(sel, count, in);
    top = scroll_to(sel, top, count);

    if (in->pressed[BSP_KEY_OK] && sel >= wifi_store_count()) open_scan();
}

void saved_paint(void *, void *, int64_t)
{
    title("wi-fi");

    const net_wifi_state_t st = net_wifi_state();
    char status[48];
    if (st == NET_WIFI_CONNECTED) snprintf(status, sizeof(status), "on %s", net_wifi_ssid());
    else snprintf(status, sizeof(status), "%s", net_wifi_state_name(st));
    text_centered(status, 44, st == NET_WIFI_CONNECTED ? PHOS_DIM : AMBER_DIM);

    const int count = rows();
    for (int i = top; i < count && i < top + ROWS_VISIBLE - 1; i++) {
        const int y = LIST_TOP + 16 + (i - top) * ROW_H;
        if (i < wifi_store_count()) {
            const wifi_saved_t *e = wifi_store_at(i);
            if (!e) continue;
            const bool current = st == NET_WIFI_CONNECTED && strcmp(e->ssid, net_wifi_ssid()) == 0;
            list_row(y, e->ssid, current ? "on" : (e->password[0] ? "saved" : "open"), i == sel);
        } else {
            list_row(y, "join another...", nullptr, i == sel);
        }
    }
    scrollbar(top, count);

    if (toast[0]) draw_toast();
    else hint(sel < wifi_store_count() ? "right forgets it" : "ok scans");
}

// ── what is in range ──────────────────────────────────────────────────────

constexpr int SCAN_MAX = 16;
net_wifi_ap_t found[SCAN_MAX];
int found_count;
int scan_sel;
int scan_top;
bool waiting;
char pending_ssid[WIFI_SSID_LEN];

void join(const char *ssid, const char *password)
{
    if (wifi_store_add(ssid, password) != ESP_OK) {
        say("no room; forget one");
        return;
    }
    say("saved");
    // Does nothing while a link is up — staying put is the policy — and starts
    // looking straight away when there isn't one.
    net_wifi_retry_now();
}

void password_done(const char *text, void *)
{
    if (!text) return; // back was pressed
    join(pending_ssid, text);
}

void scan_enter(void *)
{
    scan_sel = 0;
    scan_top = 0;
    found_count = 0;
    toast[0] = '\0';
    waiting = net_wifi_scan_start() == ESP_OK;
    if (!waiting) say("busy; try again");
}

void scan_input(void *, const ui_input_t *in)
{
    if (in->pressed[BSP_KEY_BACK]) {
        ui_pop();
        return;
    }
    if (waiting) return; // nothing to choose from yet

    scan_sel = move_sel(scan_sel, found_count, in);
    scan_top = scroll_to(scan_sel, scan_top, found_count);

    if (in->pressed[BSP_KEY_OK] && found_count) {
        const net_wifi_ap_t *ap = &found[scan_sel];
        strlcpy(pending_ssid, ap->ssid, sizeof(pending_ssid));
        if (ap->open) {
            join(pending_ssid, ""); // nothing to type
            return;
        }
        text_entry_open(ap->ssid, "", WIFI_PASS_LEN, password_done, nullptr);
    }
}

void scan_paint(void *, void *, int64_t t)
{
    title("networks");

    if (waiting) {
        // Polled from paint because the scan finishes on the wifi event loop and
        // there is nothing to block on here; a frame's latency is invisible.
        if (!net_wifi_scan_busy()) {
            found_count = net_wifi_scan_results(found, SCAN_MAX);
            waiting = false;
        }
        text_centered("scanning", 110, AMBER_DIM);
        block_cursor(cv->width() / 2 - 4, 130, 8, 14, AMBER_DIM, t);
        return;
    }
    if (!found_count) {
        text_centered("nothing in range", 110, AMBER_DIM);
        hint("back returns  ·  2.4 GHz only");
        return;
    }

    for (int i = scan_top; i < found_count && i < scan_top + ROWS_VISIBLE; i++) {
        const net_wifi_ap_t *ap = &found[i];
        // Four bars' worth of signal, which is as much as anyone reads off it.
        const int bars = ap->rssi > -55 ? 4 : ap->rssi > -67 ? 3 : ap->rssi > -78 ? 2 : 1;
        char right[12];
        snprintf(right, sizeof(right), "%.*s%s", bars, "||||", ap->saved ? " *" : (ap->open ? " o" : ""));
        list_row(LIST_TOP + (i - scan_top) * ROW_H, ap->ssid, right, i == scan_sel);
    }
    scrollbar(scan_top, found_count);

    if (toast[0]) draw_toast();
    else hint("ok joins  ·  * saved  ·  o open");
}

const ui_app_t scan_app = {"networks", scan_enter, scan_input, scan_paint, nullptr, nullptr};

void open_scan()
{
    ui_push(&scan_app);
}

} // namespace

const ui_app_t wifi_app = {"wi-fi", saved_enter, saved_input, saved_paint, nullptr, nullptr};

} // namespace shell
