#include "shell_internal.hpp"

#include <stdio.h>

#include "aiclock.h"
#include "esp_timer.h"
#include "settings.h"
#include "shell.h"
#include "sounds.h"

// A pomodoro timer, and nothing else: focus, short break, focus, … and a long
// break every fourth round. The stage lengths are the only thing configurable —
// no task list, no history, nothing to fill in before you can start.
//
// The state is a stage and an end time rather than a countdown being decremented,
// so it keeps running while you are on another screen and the dashboard can show
// what is left without this having to be painted.

namespace shell {
namespace {

constexpr int ROUNDS_TO_LONG = 4; // the classic cadence; not configurable on purpose

enum stage_t { POMO_IDLE, POMO_FOCUS, POMO_SHORT, POMO_LONG };

stage_t stage = POMO_IDLE;
bool paused;
int64_t ends_at_ms;   // wall ms, while running
int32_t frozen_left;  // ms remaining, while paused
int rounds;           // focus stages finished this cycle
esp_timer_handle_t ticker;

int stage_minutes(stage_t st)
{
    switch (st) {
    case POMO_FOCUS: return settings_get(SET_POMO_WORK);
    case POMO_SHORT: return settings_get(SET_POMO_SHORT);
    case POMO_LONG:  return settings_get(SET_POMO_LONG);
    default:         return 0;
    }
}

void sync_ticker();

void begin(stage_t st)
{
    stage = st;
    paused = false;
    ends_at_ms = now_ms() + (int64_t)stage_minutes(st) * 60 * 1000;
    sync_ticker();
}

// Runs once a second whether or not anything is on screen, because a pomodoro you
// have to watch is not doing its job.
void tick(void *)
{
    if (stage == POMO_IDLE || paused) return;
    if (now_ms() < ends_at_ms) return;

    if (stage == POMO_FOCUS) {
        rounds++;
        begin(rounds % ROUNDS_TO_LONG == 0 ? POMO_LONG : POMO_SHORT);
    } else {
        if (stage == POMO_LONG) rounds = 0;
        begin(POMO_FOCUS);
    }
    // Chime rather than ring: a stage change is a nudge, not an alarm, and this can
    // go off while you are in the middle of something else.
    sounds_play(stage == POMO_FOCUS ? "ok" : "chime", -1);
}

void ensure_ticker()
{
    if (ticker) return;
    // Every field named: C++ will not fill the gaps in a designated initialiser
    // the way C does, and the build treats that as an error.
    const esp_timer_create_args_t args = {
        .callback = tick,
        .arg = nullptr,
        .dispatch_method = ESP_TIMER_TASK,
        .name = "pomo",
        .skip_unhandled_events = true,
    };
    esp_timer_create(&args, &ticker);
}

// Runs only while there is something to count down. It used to be started the first
// time the screen was opened and never stopped again, so merely looking at the
// pomodoro app cost a wake-up a second for the rest of the boot — which mattered not
// at all on usb and matters on a battery.
void sync_ticker()
{
    if (!ticker) return;
    const bool want = stage != POMO_IDLE && !paused;
    const bool running = esp_timer_is_active(ticker);
    if (want && !running) esp_timer_start_periodic(ticker, 1000 * 1000);
    else if (!want && running) esp_timer_stop(ticker);
}

// ── the app ───────────────────────────────────────────────────────────────

int sel; // which stage length is being changed, while idle

void enter(void *)
{
    ensure_ticker();
    sync_ticker();
    sel = 0;
}

const setting_id_t LENGTHS[3] = {SET_POMO_WORK, SET_POMO_SHORT, SET_POMO_LONG};

void input(void *, const ui_input_t *in)
{
    const int64_t t = now_ms();
    if (in->pressed[BSP_KEY_BACK]) {
        ui_pop();
        return;
    }

    if (stage == POMO_IDLE) {
        sel = move_sel(sel, 3, in);
        const setting_id_t id = LENGTHS[sel];
        const setting_spec_t *sp = settings_spec(id);
        if (repeating(BSP_KEY_LEFT, in, t)) settings_set(id, settings_get(id) - sp->step);
        if (repeating(BSP_KEY_RIGHT, in, t)) settings_set(id, settings_get(id) + sp->step);
        if (in->pressed[BSP_KEY_OK]) {
            rounds = 0;
            begin(POMO_FOCUS);
        }
        return;
    }

    if (in->pressed[BSP_KEY_OK]) {
        if (paused) {
            ends_at_ms = now_ms() + frozen_left;
            paused = false;
        } else {
            frozen_left = (int32_t)(ends_at_ms - now_ms());
            paused = true;
        }
        // Nothing counts down while paused, so nothing needs to wake for it either.
        sync_ticker();
    }
    // Left stops the whole thing; right skips to the next stage, which is what you
    // want when a break arrives mid-sentence.
    if (in->pressed[BSP_KEY_LEFT]) {
        stage = POMO_IDLE;
        rounds = 0;
        sync_ticker();
    }
    if (in->pressed[BSP_KEY_RIGHT]) {
        ends_at_ms = now_ms();
        paused = false;
        tick(nullptr);
    }
}

void paint(void *, void *, int64_t)
{
    title("pomodoro");
    char buf[32];

    if (stage == POMO_IDLE) {
        for (int i = 0; i < 3; i++) {
            const setting_spec_t *sp = settings_spec(LENGTHS[i]);
            snprintf(buf, sizeof(buf), "%d m", settings_get(LENGTHS[i]));
            list_row(LIST_TOP + i * ROW_H, sp->label, buf, i == sel);
        }
        small();
        text_centered("left/right sets the length", 178, AMBER_FAINT);
        hint("ok starts a focus round");
        return;
    }

    const int left = pomodoro_seconds_left();
    const uint32_t tone = stage == POMO_FOCUS ? PHOS : INFO;
    small();
    text_centered(pomodoro_stage_name(), 52, tone);

    snprintf(buf, sizeof(buf), "%d:%02d", left / 60, left % 60);
    cv->setFont(&fonts::FreeMonoBold18pt7b);
    cv->setTextColor(paused ? AMBER_DIM : tone);
    cv->drawString(buf, (cv->width() - cv->textWidth(buf)) / 2, 84);

    // How far through the stage, and how far through the cycle.
    const int total = stage_minutes(stage) * 60;
    const float frac = total > 0 ? 1.0f - (float)left / (float)total : 0.0f;
    const int w = cv->width() - 60;
    cv->fillRect(30, 134, w, 3, dim(tone, 0.15f));
    cv->fillRect(30, 134, (int)(w * frac), 3, paused ? AMBER_DIM : tone);

    small();
    for (int i = 0; i < ROUNDS_TO_LONG; i++) {
        const int x = cv->width() / 2 - (ROUNDS_TO_LONG * 16) / 2 + i * 16 + 8;
        if (i < rounds % ROUNDS_TO_LONG || (stage == POMO_LONG && i < ROUNDS_TO_LONG)) {
            cv->fillCircle(x, 160, 4, PHOS_DIM);
        } else {
            cv->drawCircle(x, 160, 4, AMBER_FAINT);
        }
    }

    if (paused) text_centered("paused", 184, AMBER);
    hint(paused ? "ok resumes  ·  left stops" : "ok pauses  ·  right skips");
}

} // namespace

// ── what the dashboard needs ──────────────────────────────────────────────

bool pomodoro_running()
{
    return stage != POMO_IDLE;
}

bool pomodoro_paused()
{
    return paused;
}

const char *pomodoro_stage_name()
{
    switch (stage) {
    case POMO_FOCUS: return "focus";
    case POMO_SHORT: return "short break";
    case POMO_LONG:  return "long break";
    default:         return "";
    }
}

int pomodoro_seconds_left()
{
    if (stage == POMO_IDLE) return 0;
    const int64_t ms = paused ? frozen_left : ends_at_ms - now_ms();
    return ms > 0 ? (int)(ms / 1000) : 0;
}

int pomodoro_round()
{
    // While working, the round being worked. While resting, the one just finished —
    // a break after the first focus is part of round one, not a preview of round two.
    const int done = rounds % ROUNDS_TO_LONG;
    if (stage == POMO_FOCUS) return done + 1;
    return done == 0 ? ROUNDS_TO_LONG : done;
}

const ui_app_t pomodoro_app = {"pomodoro", enter, input, paint, nullptr, nullptr};

} // namespace shell

extern "C" {

void shell_pomodoro_start(void)
{
    shell::ensure_ticker();
    shell::rounds = 0;
    shell::begin(shell::POMO_FOCUS);
}

void shell_pomodoro_skip(void)
{
    if (shell::stage == shell::POMO_IDLE) return;
    shell::ends_at_ms = shell::now_ms();
    shell::paused = false;
    shell::tick(nullptr);
}

void shell_pomodoro_stop(void)
{
    shell::stage = shell::POMO_IDLE;
    shell::rounds = 0;
    shell::sync_ticker();
}

void shell_pomodoro_status(char *out, size_t n)
{
    if (!shell::pomodoro_running()) {
        snprintf(out, n, "not running");
        return;
    }
    const int left = shell::pomodoro_seconds_left();
    snprintf(out, n, "%s %d/4  %d:%02d left%s", shell::pomodoro_stage_name(), shell::pomodoro_round(),
             left / 60, left % 60, shell::pomodoro_paused() ? "  paused" : "");
}

} // extern "C"
