#include "shell_internal.hpp"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "aiclock.h"
#include "notify.h"
#include "schedule.h"
#include "settings.h"

// The resting face of the device: the time, whatever is counting down, and whether
// it can reach the server. It replaces the old status screen, so this is what the
// terminal looks like when nobody is talking to it.
//
// Painter only. Keys are not routed here, so back still opens the launcher and
// everything means the same thing it does on every other screen.

namespace shell {
namespace {

// The link line sits along the top, so the clock and everything else drops below it.
constexpr int LINK_Y = 14;
constexpr int FACE_CY = 112;

void draw_digital(int64_t t)
{
    char buf[16];
    aiclock_time_str(buf, sizeof(buf), false);
    cv->setFont(&fonts::FreeMonoBold18pt7b);
    cv->setTextColor(aiclock_ready() ? FG : AMBER_FAINT);
    const int w = cv->textWidth(buf);
    const int x = (cv->width() - w) / 2;
    cv->drawString(buf, x, FACE_CY - 22);

    if (aiclock_ready()) {
        // am/pm and the seconds set small beside the digits: present if you look for
        // them, never competing with the time itself.
        small();
        cv->setTextColor(AMBER);
        cv->drawString(aiclock_ampm(), x + w + 5, FACE_CY - 16);
        struct tm tm;
        aiclock_local(&tm);
        snprintf(buf, sizeof(buf), ":%02d", tm.tm_sec);
        cv->setTextColor(dim(PHOS, (t / 500) % 2 ? 0.9f : 0.45f));
        cv->drawString(buf, x + w + 5, FACE_CY + 2);
    }

    aiclock_date_str(buf, sizeof(buf));
    small();
    text_centered(buf, FACE_CY + 22, AMBER);
}

void hand(int cx, int cy, float turns, int len, int thick, uint32_t colour)
{
    // Straight up is 0, clockwise, which is what an angle from twelve means here.
    const float a = (turns - 0.25f) * 6.2831853f;
    const int x = cx + (int)(cosf(a) * len);
    const int y = cy + (int)(sinf(a) * len);
    for (int i = 0; i < thick; i++) {
        // Thickness by drawing neighbouring lines: LovyanGFX has no wide-line call,
        // and at this size a one-pixel hour hand disappears.
        cv->drawLine(cx + (i % 2), cy + (i / 2), x + (i % 2), y + (i / 2), colour);
    }
}

void draw_analog(int64_t t)
{
    const int cx = cv->width() / 2;
    const int cy = FACE_CY;
    constexpr int R = 58;

    cv->drawCircle(cx, cy, R, AMBER_FAINT);
    for (int i = 0; i < 12; i++) {
        const float a = (i / 12.0f - 0.25f) * 6.2831853f;
        const int inner = i % 3 == 0 ? R - 8 : R - 4;
        cv->drawLine(cx + (int)(cosf(a) * inner), cy + (int)(sinf(a) * inner),
                     cx + (int)(cosf(a) * (R - 1)), cy + (int)(sinf(a) * (R - 1)),
                     i % 3 == 0 ? AMBER : AMBER_FAINT);
    }

    if (!aiclock_ready()) {
        small();
        text_centered("--:--", cy - 6, AMBER_FAINT);
        return;
    }

    struct tm tm;
    aiclock_local(&tm);
    const float secs = tm.tm_sec / 60.0f;
    const float mins = (tm.tm_min + secs) / 60.0f;
    const float hours = ((tm.tm_hour % 12) + mins) / 12.0f;

    hand(cx, cy, hours, R - 26, 3, FG);
    hand(cx, cy, mins, R - 14, 2, FG);
    hand(cx, cy, secs, R - 8, 1, PHOS);
    cv->fillCircle(cx, cy, 3, PHOS);

    char buf[24];
    aiclock_date_str(buf, sizeof(buf));
    small();
    text_centered(buf, cy + R + 6, AMBER);
}

// Whatever is counting down: a pomodoro stage takes precedence, since starting one
// is a deliberate act, and otherwise the nearest timer.
bool draw_countdown(int y)
{
    char buf[48];
    if (pomodoro_running()) {
        const int left = pomodoro_seconds_left();
        snprintf(buf, sizeof(buf), "%s %d/4", pomodoro_stage_name(), pomodoro_round());
        small();
        text_at(buf, 12, y, strcmp(pomodoro_stage_name(), "focus") == 0 ? PHOS : INFO);
        snprintf(buf, sizeof(buf), "%d:%02d%s", left / 60, left % 60, pomodoro_paused() ? " paused" : "");
        text_right(buf, cv->width() - 12, y, FG);
        return true;
    }

    const sched_entry_t *soonest = nullptr;
    for (int i = 0; i < sched_count(); i++) {
        const sched_entry_t *e = sched_at(i);
        if (!e->enabled || e->kind != SCHED_TIMER) continue;
        if (!soonest || e->fires_at < soonest->fires_at) soonest = e;
    }
    if (!soonest) return false;

    const int left = sched_seconds_left(soonest);
    small();
    text_at(soonest->label, 12, y, AMBER);
    snprintf(buf, sizeof(buf), "%d:%02d", left / 60, left % 60);
    text_right(buf, cv->width() - 12, y, FG);
    return true;
}

// The next alarm, when nothing is counting down — an empty strip under a clock
// looks like something failed to load.
void draw_next_alarm(int y)
{
    const sched_entry_t *next = nullptr;
    for (int i = 0; i < sched_count(); i++) {
        const sched_entry_t *e = sched_at(i);
        if (!e->enabled || e->kind != SCHED_ALARM || e->fires_at == 0) continue;
        if (!next || e->fires_at < next->fires_at) next = e;
    }
    small();
    if (!next) {
        text_centered("nothing scheduled", y, AMBER_FAINT);
        return;
    }
    char when[48];
    sched_describe(next, when, sizeof(when));
    text_at(next->label, 12, y, AMBER_DIM);
    text_right(when, cv->width() - 12, y, AMBER_FAINT);
}

// The link, along the top where a status bar belongs.
void draw_link(int64_t t)
{
    const char *link = ui_link_state();
    const bool up = strcmp(link, "linked") == 0;
    const uint32_t accent = up ? PHOS : AMBER;

    // A dot that breathes while the link is up, so a still screen still looks alive.
    const float pulse = 0.45f + 0.55f * (0.5f + 0.5f * sinf(t / 420.0f));
    cv->fillCircle(16, LINK_Y + 5, 4, dim(accent, up ? pulse : 0.5f));

    small();
    const char *ip = ui_ip();
    text_at(up && ip[0] ? ip : link, 27, LINK_Y, accent);

    // Unread notifications take the right-hand corner from the ntp marker: whether
    // the clock came from ntp is a detail, whether something is waiting is not.
    const int unread = notify_unread();
    if (unread > 0) {
        char badge[16];
        snprintf(badge, sizeof(badge), "* %d", unread);
        text_right(badge, cv->width() - 12, LINK_Y, AMBER);
    } else if (up && ip[0]) {
        text_right(aiclock_synced() ? "ntp" : "", cv->width() - 12, LINK_Y, AMBER_FAINT);
    }
    cv->drawFastHLine(12, LINK_Y + 22, cv->width() - 24, dim(AMBER, 0.18f));
}

void paint(void *, void *, int64_t t)
{
    draw_link(t);

    if (settings_get(SET_CLOCK_STYLE)) draw_analog(t);
    else draw_digital(t);

    // What is running, along the bottom.
    constexpr int ROW = 206;
    cv->drawFastHLine(12, ROW - 14, cv->width() - 24, dim(AMBER, 0.18f));
    if (!draw_countdown(ROW)) draw_next_alarm(ROW);
}

} // namespace

const ui_app_t dashboard_app = {"dashboard", nullptr, nullptr, paint, nullptr, nullptr};

} // namespace shell
