#include "shell_internal.hpp"

#include <stdio.h>
#include <string.h>

#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"

// What the board is doing, on the glass instead of down a cable, plus the key test
// that started all of this — it is what caught the five-way being wired with its
// axes swapped, and it is the first thing to reach for if a key ever stops working.

namespace shell {
namespace {

// ── the key test ──────────────────────────────────────────────────────────

const char *last_key = "-";
int presses;
bool back_down;

void keytest_enter(void *)
{
    last_key = "-";
    presses = 0;
    back_down = false;
}

void keytest_input(void *, const ui_input_t *in)
{
    for (int k = 0; k < BSP_KEY_COUNT; k++) {
        if (!in->pressed[k]) continue;
        last_key = bsp_key_name((bsp_key_t)k);
        presses++;
    }
    // Back leaves on the release rather than the press, so the press still lights
    // its pad and is named first. Otherwise back would be the one key this test
    // cannot show, which is exactly the key you would come here to check.
    if (in->pressed[BSP_KEY_BACK]) back_down = true;
    else if (back_down && !in->held[BSP_KEY_BACK]) ui_pop();
}

// Five pads in a plus, plus the back key beside them, each lit while its contact
// is closed. Reading the name as well as seeing the light is the point: "the up pad
// lit" and "the firmware calls it up" are only the same claim if the wiring is right.
void draw_pad(int cx, int cy)
{
    constexpr int S = 26;
    constexpr int G = 30;
    const struct {
        bsp_key_t key;
        int dx, dy;
    } pads[] = {
        {BSP_KEY_UP, 0, -1}, {BSP_KEY_DOWN, 0, 1}, {BSP_KEY_LEFT, -1, 0},
        {BSP_KEY_RIGHT, 1, 0}, {BSP_KEY_OK, 0, 0},
    };
    for (const auto &p : pads) {
        const bool on = bsp_key_down(p.key);
        const int x = cx + p.dx * G - S / 2;
        const int y = cy + p.dy * G - S / 2;
        cv->fillRoundRect(x, y, S, S, 5, on ? PHOS : dim(AMBER, 0.14f));
        cv->drawRoundRect(x, y, S, S, 5, on ? PHOS : AMBER_FAINT);
    }
    const bool back_on = bsp_key_down(BSP_KEY_BACK);
    cv->fillRoundRect(cx + G * 2 - 4, cy - S / 2, S, S, 5, back_on ? PHOS : dim(AMBER, 0.14f));
    cv->drawRoundRect(cx + G * 2 - 4, cy - S / 2, S, S, 5, back_on ? PHOS : AMBER_FAINT);
    text_centered("back", cy + S / 2 + 4, AMBER_FAINT);
}

void keytest_paint(void *, void *, int64_t)
{
    title("key test");
    draw_pad(cv->width() / 2 - 22, 108);
    char buf[40];
    snprintf(buf, sizeof(buf), "last: %s", last_key);
    text_centered(buf, 168, PHOS);
    snprintf(buf, sizeof(buf), "%d presses", presses);
    text_centered(buf, 190, AMBER_FAINT);
    hint("back leaves");
}

// ── device info ───────────────────────────────────────────────────────────

int info_top;

void info_enter(void *)
{
    info_top = 0;
}

void info_input(void *, const ui_input_t *in)
{
    if (in->pressed[BSP_KEY_BACK]) {
        ui_pop();
        return;
    }
    if (in->pressed[BSP_KEY_UP] && info_top > 0) info_top--;
    if (in->pressed[BSP_KEY_DOWN]) info_top++;
}

void info_paint(void *, void *, int64_t)
{
    title("device");

    wifi_ap_record_t ap = {};
    const bool linked = esp_wifi_sta_get_ap_info(&ap) == ESP_OK;
    esp_netif_ip_info_t ip = {};
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (netif) esp_netif_get_ip_info(netif, &ip);

    char rows[8][40];
    int n = 0;
    const int64_t up = esp_timer_get_time() / 1000000;
    snprintf(rows[n++], 40, "up %lldh %02lldm", up / 3600, (up % 3600) / 60);
    snprintf(rows[n++], 40, "heap %u KB", (unsigned)(esp_get_free_heap_size() / 1024));
    snprintf(rows[n++], 40, "psram %u KB", (unsigned)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) / 1024));
    snprintf(rows[n++], 40, "wifi %s", linked ? (const char *)ap.ssid : "down");
    if (linked) snprintf(rows[n++], 40, "rssi %d dBm", ap.rssi);
    snprintf(rows[n++], 40, IPSTR, IP2STR(&ip.ip));
    snprintf(rows[n++], 40, "fw %s", esp_app_get_description()->version);

    if (info_top > n - ROWS_VISIBLE) info_top = n > ROWS_VISIBLE ? n - ROWS_VISIBLE : 0;
    for (int i = info_top; i < n && i < info_top + ROWS_VISIBLE; i++) {
        text_at(rows[i], 18, LIST_TOP + (i - info_top) * ROW_H, i == info_top ? FG : AMBER_DIM);
    }
    scrollbar(info_top, n);
    hint("back leaves");
}

// ── the diagnostics menu ──────────────────────────────────────────────────

int sel;

const ui_app_t info_app = {"device", info_enter, info_input, info_paint, nullptr, nullptr};

void diag_enter(void *)
{
    sel = 0;
}

void diag_input(void *, const ui_input_t *in)
{
    if (in->pressed[BSP_KEY_BACK]) {
        ui_pop();
        return;
    }
    sel = move_sel(sel, 2, in);
    if (in->pressed[BSP_KEY_OK]) ui_push(sel == 0 ? &info_app : &keytest_app);
}

void diag_paint(void *, void *, int64_t)
{
    title("diagnostics");
    list_row(LIST_TOP, "device", nullptr, sel == 0);
    list_row(LIST_TOP + ROW_H, "key test", nullptr, sel == 1);
    hint("ok opens  ·  back leaves");
}

} // namespace

const ui_app_t keytest_app = {"key test", keytest_enter, keytest_input, keytest_paint, nullptr, nullptr};
const ui_app_t diag_app = {"diagnostics", diag_enter, diag_input, diag_paint, nullptr, nullptr};

} // namespace shell
