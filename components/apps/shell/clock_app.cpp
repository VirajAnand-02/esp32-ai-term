#include "shell_internal.hpp"

#include <stdio.h>
#include <string.h>

#include "aiclock.h"
#include "schedule.h"
#include "settings.h"

// The time-based screens: a clock face, a countdown timer, the alarm list, and a
// stopwatch. Setting anything with five keys means picking numbers rather than
// typing them, so every editor here is the same shape — up and down choose the
// field, left and right change it, ok confirms.

namespace shell {
namespace {

// ── clock face ────────────────────────────────────────────────────────────

void clock_input(void *, const ui_input_t *in)
{
    if (in->pressed[BSP_KEY_BACK]) {
        ui_pop();
        return;
    }
    // The face the dashboard uses is chosen here, because here is where you can see
    // what you are choosing between.
    if (in->pressed[BSP_KEY_LEFT] || in->pressed[BSP_KEY_RIGHT] || in->pressed[BSP_KEY_OK]) {
        settings_set(SET_CLOCK_STYLE, settings_get(SET_CLOCK_STYLE) ? 0 : 1);
    }
}

void clock_paint(void *, void *, int64_t t)
{
    char buf[80]; // holds a schedule description and its label together
    aiclock_time_str(buf, sizeof(buf), false);

    cv->setFont(&fonts::FreeMonoBold18pt7b);
    cv->setTextColor(aiclock_ready() ? PHOS : AMBER_FAINT);
    const int tw = cv->textWidth(buf);
    const int tx = (cv->width() - tw) / 2;
    cv->drawString(buf, tx, 74);

    small();
    if (aiclock_ready()) {
        // am/pm and the seconds set small beside the digits, so the big read stays
        // uncluttered while both are still there if you look.
        cv->setTextColor(AMBER);
        cv->drawString(aiclock_ampm(), tx + tw + 5, 80);
        struct tm tm;
        aiclock_local(&tm);
        snprintf(buf, sizeof(buf), ":%02d", tm.tm_sec);
        cv->setTextColor(AMBER_DIM);
        cv->drawString(buf, tx + tw + 5, 98);
    }
    aiclock_date_str(buf, sizeof(buf));
    text_centered(buf, 140, AMBER);

    if (!aiclock_ready()) {
        text_centered("waiting for the network", 170, AMBER_FAINT);
    } else {
        // What is coming up, since a clock with alarms set should say so.
        int shown = 0;
        for (int i = 0; i < sched_count() && shown < 2; i++) {
            const sched_entry_t *e = sched_at(i);
            if (!e->enabled) continue;
            char when[48];
            sched_describe(e, when, sizeof(when));
            snprintf(buf, sizeof(buf), "%s  %s", when, e->label);
            text_centered(buf, 176 + shown * 18, AMBER_FAINT);
            shown++;
        }
        if (!shown) text_centered(aiclock_synced() ? "" : "server time", 176, AMBER_FAINT);
    }
    char style[32];
    snprintf(style, sizeof(style), "face: %s", settings_get(SET_CLOCK_STYLE) ? "analog" : "digital");
    text_centered(style, 200, AMBER_DIM);
    hint("left/right changes the face");
}

// ── countdown timer ───────────────────────────────────────────────────────

int pick_min = 5;
int pick_sec = 0;
int pick_field; // 0 minutes, 1 seconds
uint32_t running_id;

void timer_enter(void *)
{
    pick_field = 0;
    running_id = 0;
    // If one is already going, show it rather than the picker.
    for (int i = 0; i < sched_count(); i++) {
        if (sched_at(i)->kind == SCHED_TIMER) {
            running_id = sched_at(i)->id;
            break;
        }
    }
}

void timer_input(void *, const ui_input_t *in)
{
    const int64_t t = now_ms();
    if (in->pressed[BSP_KEY_BACK]) {
        ui_pop();
        return;
    }
    if (running_id) {
        // Running: ok cancels it and goes back to the picker.
        if (in->pressed[BSP_KEY_OK]) {
            sched_cancel(running_id);
            running_id = 0;
        }
        if (!sched_find(running_id)) running_id = 0; // it went off while we watched
        return;
    }
    if (in->pressed[BSP_KEY_UP] || in->pressed[BSP_KEY_DOWN]) pick_field ^= 1;
    int *field = pick_field ? &pick_sec : &pick_min;
    const int step = pick_field ? 5 : 1;
    const int max = pick_field ? 55 : 180;
    if (repeating(BSP_KEY_LEFT, in, t)) *field = *field - step < 0 ? max : *field - step;
    if (repeating(BSP_KEY_RIGHT, in, t)) *field = *field + step > max ? 0 : *field + step;
    if (in->pressed[BSP_KEY_OK]) {
        const int secs = pick_min * 60 + pick_sec;
        if (secs > 0) running_id = sched_add_timer(secs, "timer", nullptr);
    }
}

void timer_paint(void *, void *, int64_t t)
{
    title("timer");
    char buf[40];

    const sched_entry_t *e = running_id ? sched_find(running_id) : nullptr;
    if (e) {
        const int left = sched_seconds_left(e);
        snprintf(buf, sizeof(buf), "%d:%02d", left / 60, left % 60);
        cv->setFont(&fonts::FreeMonoBold18pt7b);
        cv->setTextColor(left <= 10 ? ERR : PHOS);
        cv->drawString(buf, (cv->width() - cv->textWidth(buf)) / 2, 92);

        // A ring draining as it runs, so the remaining time has a shape too.
        const int total = (int)(e->fires_at - (aiclock_now() - left)) - (int)aiclock_now() + left;
        const float frac = total > 0 ? (float)left / (float)total : 0.0f;
        small();
        const int w = cv->width() - 60;
        cv->fillRect(30, 150, w, 3, dim(AMBER, 0.15f));
        cv->fillRect(30, 150, (int)(w * frac), 3, left <= 10 ? ERR : PHOS_DIM);
        hint("ok cancels  ·  back leaves");
        return;
    }

    snprintf(buf, sizeof(buf), "%02d:%02d", pick_min, pick_sec);
    cv->setFont(&fonts::FreeMonoBold18pt7b);
    cv->setTextColor(AMBER);
    const int w = cv->textWidth(buf);
    const int x = (cv->width() - w) / 2;
    cv->drawString(buf, x, 88);
    // Underline whichever half is being changed, rather than a cursor that would
    // have nowhere to sit between two numbers.
    const int half = w / 2;
    cv->fillRect(pick_field ? x + half + 6 : x, 126, half - 6, 2, PHOS);

    small();
    text_centered(pick_field ? "seconds" : "minutes", 140, AMBER_DIM);
    text_centered("up/down picks  ·  left/right sets", 170, AMBER_FAINT);
    hint("ok starts  ·  back leaves");
}

// ── alarms ────────────────────────────────────────────────────────────────

int alarm_sel;
bool adding;
int new_hour = 7, new_min = 0, new_field;

int alarm_count()
{
    int n = 0;
    for (int i = 0; i < sched_count(); i++) {
        if (sched_at(i)->kind == SCHED_ALARM) n++;
    }
    return n;
}

const sched_entry_t *alarm_at(int index)
{
    int n = 0;
    for (int i = 0; i < sched_count(); i++) {
        const sched_entry_t *e = sched_at(i);
        if (e->kind != SCHED_ALARM) continue;
        if (n++ == index) return e;
    }
    return nullptr;
}

void alarms_enter(void *)
{
    alarm_sel = 0;
    adding = false;
}

void alarms_input(void *, const ui_input_t *in)
{
    const int64_t t = now_ms();
    if (adding) {
        if (in->pressed[BSP_KEY_BACK]) {
            adding = false;
            return;
        }
        if (in->pressed[BSP_KEY_UP] || in->pressed[BSP_KEY_DOWN]) new_field ^= 1;
        int *field = new_field ? &new_min : &new_hour;
        const int step = new_field ? 5 : 1;
        const int max = new_field ? 55 : 23;
        if (repeating(BSP_KEY_LEFT, in, t)) *field = *field - step < 0 ? max : *field - step;
        if (repeating(BSP_KEY_RIGHT, in, t)) *field = *field + step > max ? 0 : *field + step;
        if (in->pressed[BSP_KEY_OK]) {
            // Daily by default: a one-off alarm is the rarer thing to want, and the
            // agent can set anything more specific.
            sched_add_alarm(new_hour, new_min, SCHED_EVERY_DAY, "alarm", nullptr);
            adding = false;
        }
        return;
    }

    if (in->pressed[BSP_KEY_BACK]) {
        ui_pop();
        return;
    }
    const int n = alarm_count() + 1; // the last row is "add"
    alarm_sel = move_sel(alarm_sel, n, in);
    if (in->pressed[BSP_KEY_OK]) {
        if (alarm_sel >= n - 1) {
            adding = true;
            new_field = 0;
            return;
        }
        const sched_entry_t *e = alarm_at(alarm_sel);
        if (e) sched_enable(e->id, !e->enabled);
    }
    // Left deletes, which is destructive enough to want its own key rather than
    // hiding behind a long press of ok.
    if (in->pressed[BSP_KEY_LEFT] && alarm_sel < n - 1) {
        const sched_entry_t *e = alarm_at(alarm_sel);
        if (e) sched_cancel(e->id);
    }
}

void alarms_paint(void *, void *, int64_t)
{
    if (adding) {
        title("new alarm");
        char buf[16];
        snprintf(buf, sizeof(buf), "%02d:%02d", new_hour, new_min);
        cv->setFont(&fonts::FreeMonoBold18pt7b);
        cv->setTextColor(AMBER);
        const int w = cv->textWidth(buf);
        const int x = (cv->width() - w) / 2;
        cv->drawString(buf, x, 92);
        const int half = w / 2;
        cv->fillRect(new_field ? x + half + 6 : x, 130, half - 6, 2, PHOS);
        small();
        text_centered("every day", 148, AMBER_DIM);
        hint("ok saves  ·  back cancels");
        return;
    }

    title("alarms");
    const int n = alarm_count();
    for (int i = 0; i < n && i < ROWS_VISIBLE - 1; i++) {
        const sched_entry_t *e = alarm_at(i);
        char when[48];
        sched_describe(e, when, sizeof(when));
        list_row(LIST_TOP + i * ROW_H, when, e->enabled ? "on" : "off", i == alarm_sel);
    }
    list_row(LIST_TOP + (n < ROWS_VISIBLE - 1 ? n : ROWS_VISIBLE - 1) * ROW_H, "+ new alarm", nullptr,
             alarm_sel >= n);
    hint(alarm_sel >= n ? "ok adds one" : "ok toggles  ·  left deletes");
}

// ── stopwatch ─────────────────────────────────────────────────────────────

int64_t sw_started;
int64_t sw_elapsed; // frozen total while stopped
bool sw_running;
int64_t sw_lap;

void sw_enter(void *)
{
    // Deliberately not reset: coming back to a stopwatch still counting is the
    // point of leaving it running.
}

void sw_input(void *, const ui_input_t *in)
{
    if (in->pressed[BSP_KEY_BACK]) {
        ui_pop();
        return;
    }
    if (in->pressed[BSP_KEY_OK]) {
        if (sw_running) {
            sw_elapsed += now_ms() - sw_started;
            sw_running = false;
        } else {
            sw_started = now_ms();
            sw_running = true;
        }
    }
    if (in->pressed[BSP_KEY_RIGHT] && sw_running) sw_lap = sw_elapsed + (now_ms() - sw_started);
    if (in->pressed[BSP_KEY_LEFT] && !sw_running) {
        sw_elapsed = 0;
        sw_lap = 0;
    }
}

void sw_paint(void *, void *, int64_t)
{
    title("stopwatch");
    const int64_t ms = sw_elapsed + (sw_running ? now_ms() - sw_started : 0);

    char buf[24];
    snprintf(buf, sizeof(buf), "%d:%02d.%d", (int)(ms / 60000), (int)((ms / 1000) % 60), (int)((ms % 1000) / 100));
    cv->setFont(&fonts::FreeMonoBold18pt7b);
    cv->setTextColor(sw_running ? PHOS : AMBER);
    cv->drawString(buf, (cv->width() - cv->textWidth(buf)) / 2, 88);

    small();
    if (sw_lap) {
        snprintf(buf, sizeof(buf), "lap %d:%02d.%d", (int)(sw_lap / 60000), (int)((sw_lap / 1000) % 60),
                 (int)((sw_lap % 1000) / 100));
        text_centered(buf, 136, AMBER_DIM);
    }
    text_centered(sw_running ? "right marks a lap" : "left resets", 166, AMBER_FAINT);
    hint(sw_running ? "ok stops  ·  back leaves" : "ok starts  ·  back leaves");
}

} // namespace

const ui_app_t clock_app = {"clock", nullptr, clock_input, clock_paint, nullptr, nullptr};
const ui_app_t timer_app = {"timer", timer_enter, timer_input, timer_paint, nullptr, nullptr};
const ui_app_t alarms_app = {"alarms", alarms_enter, alarms_input, alarms_paint, nullptr, nullptr};
const ui_app_t stopwatch_app = {"stopwatch", sw_enter, sw_input, sw_paint, nullptr, nullptr};

} // namespace shell
