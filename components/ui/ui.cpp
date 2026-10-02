#include <LovyanGFX.hpp>

#include <math.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "bsp.h"
#include "ui.h"
#include "ui_draw.hpp"

// The terminal's face. A single task composes every frame into the bsp back buffer
// and pushes it once, so nothing tears; the rest of the firmware just says what it
// is doing and never waits for a repaint.
//
// The look follows the dashboard: amber phosphor on near-black, scanlines, and a
// block cursor that blinks.

static const char *TAG = "ui";

// Pushing the whole 240x240 back buffer costs ~46 ms at 20 MHz, so this is about
// as fast as the panel goes. Raise BOARD_LCD_HZ to 40 MHz for roughly double.
#define FPS        15
#define FRAME_MS   (1000 / FPS)
// While the panel is blanked there is nothing to draw, so the loop runs only often
// enough to notice a key press. Five times a second is imperceptible on the way back
// up and leaves the chip idle the rest of the time, which is the whole point.
#define DARK_FRAME_MS 200
#define MIN_YIELD  8 // never hog the core, however long a frame took
#define TRANSITION 260.0f // ms a screen takes to slide in

namespace {

// The palette, the canvas and the text helpers are shared with everything that
// draws on this panel.
using namespace uidraw;

enum mode_t {
    MODE_BOOT,
    MODE_STATUS,
    MODE_PROMPT,
    MODE_REPLY,
    MODE_LISTENING,
    MODE_SENDING,
    MODE_ERROR,
    MODE_RAW,
};

struct state_t {
    mode_t mode = MODE_BOOT;
    int64_t since = 0;
    // A display tool has drawn something. Streaming reply text must not paint over
    // it: the picture is the answer, and there is no way to scroll back to it.
    bool held = false;

    char boot_step[40] = "starting";
    int boot_index = 0;

    char link[24] = "starting";
    char ip[16] = "";

    char prompt[224] = "";
    char origin[8] = "device";

    char reply[900] = "";
    size_t reply_len = 0;
    bool reply_done = false;
    bool aborted = false;
    int tin = 0, tout = 0;

    char working[40] = "";
    // What the turn is doing, for the sending splash. Empty falls back to
    // "transcribing", which is true for the moment before the server says otherwise.
    char stage[40] = "";
    char stage_detail[40] = "";
    char error[200] = "";
    // Whether `error` is a failure or just something to mention. The difference is
    // worth carrying: a red "!! error" for catching silence reads as a broken link.
    bool error_is_notice = false;

    int listen_secs = 0;
    int64_t listen_start = 0;
    float level = 0, level_peak = 0;
};

state_t g;
SemaphoreHandle_t g_lock;

// ── the backlight and the idle timer ──────────────────────────────────────
// The dim is a multiplier on the level settings asked for, never a replacement for
// it: that way turning the brightness up while dimmed does the obvious thing, and
// waking up restores exactly what was configured.
int bl_base = 100;      // what settings wants
int bl_now = -1;        // what the panel is actually at, -1 = not yet pushed
int dim_after_s = 0;    // 0 disables
int blank_after_s = 0;
int64_t last_activity;  // ms
// Set when a key arrives while the panel is dark. The key that wakes the screen
// should still do its job — except back, which would otherwise take you up a level
// you could not see you were on.
bool woke_from_dark;

constexpr float DIM_FRACTION = 0.15f;

// ── the screen stack ──────────────────────────────────────────────────────
// Six, because the wi-fi flow is four deep on its own — launcher, settings, the
// network list, the password editor — and sitting exactly on the limit leaves no
// room for the next feature that nests one further. A push beyond this is logged
// rather than silently dropped; a screen going missing with nothing to show for it
// is a miserable thing to debug.
constexpr int STACK_MAX = 6;

const ui_app_t *stack[STACK_MAX];
int depth;
const ui_app_t *home;       // what the back key opens from the terminal
const ui_app_t *dashboard;  // what the idle screen shows instead of screen_status
const ui_app_t *drawer;     // what the down key pulls down from the dashboard
const ui_app_t *right_app;  // what the right key opens from the dashboard
const ui_app_t *entered;    // the app whose enter() has run, so exit() is paired

// Whether the current MODE_RAW holder is actively writing to the glass (the video
// player) or has simply left a picture there (a display tool). A picture can be
// taken over by the menu; a writer cannot, or the two tear against each other.
bool exclusive;

// A notice that arrived while an app was open. It is not important enough to throw
// anyone out of the settings screen, but it used to be dropped on the floor instead
// of waiting, so you never learnt the microphone had caught silence.
char pending_notice[200];

// Back during a recording cancels it. The interface has no idea what a recorder is,
// so whoever owns one registers the abort.
ui_cancel_cb_t cancel_cb;

void lock()
{
    xSemaphoreTake(g_lock, portMAX_DELAY);
}

void unlock()
{
    xSemaphoreGive(g_lock);
}

// Called once a frame. Only touches the hardware when the level actually changes,
// so a steady screen costs nothing.
void update_backlight(int64_t t)
{
    int want = bl_base;
    const int64_t idle = (t - last_activity) / 1000;
    if (blank_after_s > 0 && idle >= blank_after_s) {
        want = 0;
    } else if (dim_after_s > 0 && idle >= dim_after_s) {
        want = (int)(bl_base * DIM_FRACTION);
        if (want < 3) want = 3; // dim, but not indistinguishable from off
    }
    if (want == bl_now) return;
    bl_now = want;
    bsp_display_backlight(want);
    // A dark panel should be a dark device. Notifications will want an exception to
    // this later; until there are any, asleep means asleep.
    bsp_status_led_blank(want == 0);
}

void set_mode(state_t &s, mode_t m)
{
    if (s.mode != m) s.since = now_ms();
    s.mode = m;
}

// Callers already hold the lock.
void reset_reply(state_t &s)
{
    s.reply[0] = '\0';
    s.reply_len = 0;
    s.reply_done = false;
    s.aborted = false;
    s.tin = s.tout = 0;
}

// A finished answer stays on the panel until something replaces it. When the next one
// starts it has to replace it outright, not run on from the end: nine lines with two
// answers in them and no gap between reads as one muddled paragraph. Doing it here,
// on the first sign of a new turn, covers every way one can begin — typed on the
// device, sent from the dashboard, or spoken into the push-to-talk button — including
// the ones where the device is never told what was asked.
void starting_new_reply(state_t &s)
{
    if (s.reply_done) reset_reply(s);
}

uint32_t tone_color(ui_tone_t tone)
{
    switch (tone) {
    case UI_TONE_GREEN: return PHOS;
    case UI_TONE_RED:   return ERR;
    case UI_TONE_BLUE:  return INFO;
    case UI_TONE_DIM:   return AMBER_DIM;
    default:            return AMBER;
    }
}

float ease_out(float p)
{
    if (p < 0) p = 0;
    if (p > 1) p = 1;
    const float q = 1.0f - p;
    return 1.0f - q * q * q;
}

// 0..1 over the transition, then stays at 1.
float entry(const state_t &s, int64_t t)
{
    return ease_out((float)(t - s.since) / TRANSITION);
}

// ── drawing helpers ───────────────────────────────────────────────────────

// 1260 -> "1.2k", 980 -> "980", 12400 -> "12k". Room on this panel is scarce.
void compact(char *out, size_t n, int v)
{
    if (v < 1000) {
        snprintf(out, n, "%d", v);
    } else if (v < 10000) {
        const int tenths = (v + 50) / 100; // one decimal, rounded
        if (tenths % 10 == 0) snprintf(out, n, "%dk", tenths / 10);
        else snprintf(out, n, "%d.%dk", tenths / 10, tenths % 10);
    } else {
        snprintf(out, n, "%dk", (v + 500) / 1000);
    }
}

// ── screens ───────────────────────────────────────────────────────────────

void screen_boot(const state_t &s, int64_t t)
{
    const int w = cv->width();
    const float p = entry(s, t);

    cv->setFont(&fonts::FreeMonoBold18pt7b);
    const char *logo = "AI-TERM";
    // Letters land one after another, like a terminal printing its banner.
    const int shown = (int)((t - s.since) / 70);
    char partial[10] = "";
    strncpy(partial, logo, shown > 7 ? 7 : (shown < 0 ? 0 : shown));

    const int lw = cv->textWidth(logo);
    const int lx = (w - lw) / 2;
    cv->setTextColor(AMBER);
    cv->drawString(partial, lx, 84);
    if (shown < 7) block_cursor(lx + cv->textWidth(partial), 84, 14, 26, dim(AMBER, 0.7f), t);

    // A thin rule that grows out from the middle as the banner completes.
    const int rule = (int)(lw * ease_out((float)(t - s.since - 500) / 400.0f));
    if (rule > 0) cv->fillRect(w / 2 - rule / 2, 120, rule, 2, dim(AMBER, 0.6f));

    cv->setFont(&fonts::FreeMono9pt7b);
    text_centered(s.boot_step, 140, AMBER_DIM);

    // Boot progress: five steps, each one a filled cell.
    const int cells = 5, cw = 22, gap = 6;
    const int total = cells * cw + (cells - 1) * gap;
    for (int i = 0; i < cells; i++) {
        const int x = (w - total) / 2 + i * (cw + gap);
        const bool done = i < s.boot_index;
        const bool active = i == s.boot_index;
        uint32_t c = done ? AMBER : AMBER_FAINT;
        if (active) c = dim(AMBER, 0.45f + 0.45f * sinf(t / 180.0f));
        cv->fillRect(x, 172, cw, 4, c);
    }

    text_centered("esp32-s3 terminal", (int)(204 + (1 - p) * 10), AMBER_FAINT);
}

void screen_status(const state_t &s, int64_t t)
{
    const int w = cv->width();
    const float p = entry(s, t);
    const int dx = (int)((1 - p) * 30);
    const bool linked = strcmp(s.link, "linked") == 0;
    const uint32_t accent = linked ? PHOS : AMBER;

    // top rule, growing in on entry
    cv->fillRect(0, 0, (int)(w * p), 2, accent);

    cv->setFont(&fonts::FreeMonoBold12pt7b);
    cv->setTextColor(accent);
    cv->drawString("AI-TERM", 10 + dx, 12);

    cv->setFont(&fonts::FreeMono9pt7b);
    cv->setTextColor(AMBER_FAINT);
    cv->drawString("v0.2", w - 10 - cv->textWidth("v0.2"), 16);

    text_at("ai-term-01", 10 + dx, 42, FG);

    // The link line, with a dot that breathes while it is up.
    const float pulse = 0.45f + 0.55f * (0.5f + 0.5f * sinf(t / 420.0f));
    cv->fillCircle(15, 74, 4, dim(accent, linked ? pulse : 0.5f));
    if (linked) cv->drawCircle(15, 74, (int)(5 + 3 * (1 - pulse)), dim(accent, 0.3f * pulse));
    text_at(s.link, 28 + dx, 68, accent);

    char line[40];
    snprintf(line, sizeof(line), "ip   %s", s.ip[0] ? s.ip : "-");
    text_at(line, 10 + dx, 92, AMBER_DIM);

    const int up = (int)(t / 1000);
    snprintf(line, sizeof(line), "up   %02d:%02d:%02d", up / 3600, (up / 60) % 60, up % 60);
    text_at(line, 10 + dx, 112, AMBER_DIM);

    // An idle phosphor trace along the bottom, so the panel never looks frozen.
    const int base = 176;
    for (int x = 0; x < w; x++) {
        const float ph = (x + t / 22.0f) * 0.07f;
        const float amp = 9.0f * sinf(ph) * sinf(ph * 0.31f + 1.1f);
        const int y = base + (int)amp;
        cv->drawPixel(x, y, dim(accent, 0.75f));
        cv->drawPixel(x, y + 1, dim(accent, 0.22f));
    }

    const char *hint = "ask, or use the web";
    text_at(hint, 10, 210, AMBER_FAINT);
    block_cursor(10 + cv->textWidth(hint) + 5, 210, 7, 13, AMBER_DIM, t);
}

void screen_prompt(const state_t &s, int64_t t)
{
    const int w = cv->width();
    const float p = entry(s, t);
    const int dx = (int)((1 - p) * 34);
    const bool web = strcmp(s.origin, "web") == 0;
    const uint32_t accent = web ? INFO : AMBER;

    cv->fillRect(0, 0, (int)(w * p), 2, accent);
    cv->setFont(&fonts::FreeMono9pt7b);
    text_at(web ? "[web] asked" : "[device] asked", 10 + dx, 10, accent);

    // The question types itself in, a little faster than a person would.
    const int reveal = (int)((t - s.since) / 14);
    const int end = text_block(s.prompt, 10 + dx, 36, w - 20, 206, FG, 20, reveal);
    if (reveal < (int)strlen(s.prompt)) block_cursor(10 + dx, end, 7, 13, accent, t);

    cv->setTextColor(AMBER_FAINT);
    cv->drawString("thinking", 10, 216);
    // three dots chasing each other
    for (int i = 0; i < 3; i++) {
        const float ph = sinf(t / 200.0f - i * 0.8f);
        cv->fillCircle(10 + cv->textWidth("thinking") + 10 + i * 9, 212, 2, dim(accent, 0.3f + 0.7f * (ph * 0.5f + 0.5f)));
    }
}

void screen_reply(const state_t &s, int64_t t)
{
    const int w = cv->width();
    const float p = entry(s, t);

    cv->fillRect(0, 0, (int)(w * p), 2, PHOS);
    cv->setFont(&fonts::FreeMono9pt7b);
    cv->setTextColor(PHOS);
    cv->drawString("reply", 10, 10);

    if (s.working[0]) {
        // A tool is running: name it, with a rotating tick.
        static const char *SPIN = "|/-\\";
        char tag[52];
        snprintf(tag, sizeof(tag), "%c %s", SPIN[(t / 110) % 4], s.working);
        const char *t2 = fit(tag, 120);
        cv->setTextColor(AMBER);
        cv->drawString(t2, w - 10 - cv->textWidth(t2), 10);
    }

    const int bottom = s.reply_done ? 198 : 210;
    const int end = text_block(s.reply, 10, 34, w - 20, bottom, FG, 20, -1);
    if (!s.reply_done) block_cursor(10, end, 7, 13, PHOS, t);

    if (s.reply_done) {
        char foot[40];
        if (s.aborted) {
            snprintf(foot, sizeof(foot), "aborted");
        } else {
            char in[12], out[12];
            compact(in, sizeof(in), s.tin);
            compact(out, sizeof(out), s.tout);
            snprintf(foot, sizeof(foot), "%s in / %s out", in, out);
        }
        cv->setTextColor(s.aborted ? ERR : AMBER_FAINT);
        cv->drawString(foot, 10, 214);
        cv->fillRect(0, 206, (int)(w * ease_out((float)(t - s.since) / 600.0f)), 1, dim(PHOS, 0.25f));
    }
}

void screen_listening(const state_t &s, int64_t t)
{
    const int w = cv->width(), h = cv->height();
    const int cx = w / 2, cy = 104;
    const float elapsed = (t - s.listen_start) / 1000.0f;
    // A fixed-length clip counts down; the button counts up until it is let go.
    const bool held = s.listen_secs <= 0;
    const int shown = held ? (int)elapsed : s.listen_secs - (int)elapsed;

    cv->fillRect(0, 0, w, 2, ERR);
    cv->setFont(&fonts::FreeMono9pt7b);
    text_at(held ? "hold to talk" : "listening", 10, 10, ERR);

    // Rings pushed outward by how loud it actually is.
    for (int i = 0; i < 3; i++) {
        const float ph = fmodf(t / 900.0f + i * 0.33f, 1.0f);
        const int r = (int)(26 + ph * (48 + 40 * s.level));
        cv->drawCircle(cx, cy, r, dim(ERR, (1 - ph) * 0.55f));
    }
    cv->fillCircle(cx, cy, (int)(16 + 12 * s.level), dim(ERR, 0.85f));

    cv->setFont(&fonts::FreeMonoBold18pt7b);
    char num[8];
    snprintf(num, sizeof(num), "%d", shown < 0 ? 0 : (shown > 99 ? 99 : shown));
    cv->setTextColor(BG);
    cv->drawString(num, cx - cv->textWidth(num) / 2, cy - 13);

    // Level meter, with the peak held so a short shout stays visible.
    const int mx = 20, mw = w - 40, my = 182;
    cv->drawRect(mx, my, mw, 10, dim(ERR, 0.4f));
    cv->fillRect(mx + 1, my + 1, (int)((mw - 2) * s.level), 8, ERR);
    const int peak = mx + 1 + (int)((mw - 2) * s.level_peak);
    cv->fillRect(peak, my - 2, 2, 14, AMBER);

    cv->setFont(&fonts::FreeMono9pt7b);
    char pct[16];
    snprintf(pct, sizeof(pct), "peak %d%%", (int)(s.level_peak * 100));
    text_at(pct, mx, my + 16, AMBER_FAINT);
    if (held) text_centered("release to send", 214, dim(ERR, 0.8f));
    (void)h;
}

void screen_sending(const state_t &s, int64_t t)
{
    const int w = cv->width(), cx = w / 2;

    cv->fillRect(0, 0, (int)(w * entry(s, t)), 2, INFO);
    cv->setFont(&fonts::FreeMono9pt7b);
    text_at("heard you", 10, 10, INFO);

    // A ring of ticks chasing round while the words are turned into text.
    for (int i = 0; i < 12; i++) {
        const float a = i * 0.5236f; // 30 degrees
        const float lead = fmodf((t / 70.0f) - i, 12.0f) / 12.0f;
        const int x = cx + (int)(34 * cosf(a)), y = 104 + (int)(34 * sinf(a));
        cv->fillCircle(x, y, 3, dim(INFO, 0.12f + 0.88f * (1.0f - lead)));
    }

    // The stages arrive from the server as they happen: transcribing (the default
    // here, because the clip has only just gone up), then the model, then each tool
    // by name. The reply screen takes over from the first token of text.
    text_centered(s.stage[0] ? s.stage : "transcribing", 160, FG);
    text_centered(s.stage_detail[0] ? s.stage_detail : "groq whisper", 182, AMBER_FAINT);
}

void screen_error(const state_t &s, int64_t t)
{
    const int w = cv->width();
    const float p = entry(s, t);
    // A short flash on arrival, so a failure is impossible to miss.
    const uint32_t tone = s.error_is_notice ? AMBER : ERR;
    // A notice does not flash. The flash exists to make a failure impossible to
    // miss, and "I did not catch that" is not a failure.
    if (!s.error_is_notice) {
        const float flash = 1.0f - ease_out((float)(t - s.since) / 400.0f);
        if (flash > 0.02f) cv->fillScreen(dim(ERR, flash * 0.35f));
    }

    cv->fillRect(0, 0, (int)(w * p), 3, tone);
    cv->setFont(&fonts::FreeMonoBold12pt7b);
    cv->setTextColor(tone);
    cv->drawString(s.error_is_notice ? "--" : "!! error", 10, 12);

    cv->setFont(&fonts::FreeMono9pt7b);
    text_block(s.error, 10, 46, w - 20, 214, FG, 20, -1);
}

// ── the render task ───────────────────────────────────────────────────────

// Drains the queue and latches what is held. Draining matters: a tap shorter than
// a frame would be invisible to a poll of the pin alone.
void poll_keys(ui_input_t &in)
{
    memset(in.pressed, 0, sizeof(in.pressed));
    bsp_key_event_t ev;
    while (bsp_keys_wait(&ev, 0)) {
        if (ev.down) in.pressed[ev.key] = true;
    }
    for (int k = 0; k < BSP_KEY_COUNT; k++) in.held[k] = bsp_key_down((bsp_key_t)k);

    // Waking is all the first press does if it was back: everything else still acts,
    // but backing out of a screen you never saw is disorienting rather than useful.
    if (woke_from_dark) {
        woke_from_dark = false;
        in.pressed[BSP_KEY_BACK] = false;
    }
}

// Runs the enter/exit pair as the top of the stack changes. Doing it here rather
// than inside ui_push means the callbacks always run on the render task, so an app
// may draw or touch the canvas in them.
void settle_stack()
{
    const ui_app_t *top = depth > 0 ? stack[depth - 1] : nullptr;
    if (top == entered) return;
    if (entered && entered->exit) entered->exit(entered->ctx);
    entered = top;
    if (entered && entered->enter) entered->enter(entered->ctx);
}

void render_task(void *)
{
    while (true) {
        const int64_t started = now_ms();
        lock();
        const state_t s = g;
        unlock();

        // A dark panel has nothing worth drawing. Composing a full frame and pushing
        // 115 KB down the SPI bus fifteen times a second into a backlight that is
        // off was, after the key pollers, the biggest thing keeping this chip awake.
        // Keys are still read, because a press is what ends the dark.
        const bool dark = bl_now == 0;

        // The video player writes to the glass itself and takes its keys out of band
        // through on_key, so while it holds the panel there is nothing to do here.
        if (s.mode == MODE_RAW && exclusive) {
            // Deliberately empty: the housekeeping at the bottom still runs.
        } else if (s.mode == MODE_RAW) {
            // A display tool has left a picture. Its pixels have to survive, so
            // nothing repaints — but the keys are still read. Not reading them was
            // the whole bug: back did nothing, every press queued up behind it, and
            // an app that happened to be open was frozen with no way out.
            ui_input_t in;
            poll_keys(in);
            if (in.pressed[BSP_KEY_BACK] || in.pressed[BSP_KEY_OK]) ui_raw_release();
        } else if (depth > 0) {
            settle_stack();
            ui_input_t in;
            poll_keys(in);
            const ui_app_t *top = stack[depth - 1];
            if (top->input) top->input(top->ctx, &in);
            settle_stack(); // the app may have pushed or popped during input

            if (depth > 0 && !dark) {
                background();
                const ui_app_t *now_top = stack[depth - 1];
                if (now_top->paint) now_top->paint(now_top->ctx, cv, now_ms());
                bsp_display_flush();
            }
        } else {
            settle_stack(); // pairs the last exit() after a pop back to the terminal
            // A notice that arrived while an app was open waited instead of being
            // thrown away. The terminal is back, so say it now.
            if (pending_notice[0] && s.mode == MODE_STATUS) {
                char msg[sizeof(pending_notice)];
                strlcpy(msg, pending_notice, sizeof(msg));
                pending_notice[0] = '\0';
                ui_notice(msg);
            }
            ui_input_t in;
            poll_keys(in);
            // Back means "up one level" here as everywhere else. From a reply, a
            // question or an error that is the dashboard — dismiss what is on the
            // screen. Only from the dashboard, where there is nothing left to back
            // out of, does it open the launcher.
            if (in.pressed[BSP_KEY_BACK] || in.pressed[BSP_KEY_OK]) {
                const bool dismissable = s.mode == MODE_REPLY || s.mode == MODE_PROMPT || s.mode == MODE_ERROR;
                if (dismissable) {
                    lock();
                    g.held = false;
                    set_mode(g, MODE_STATUS);
                    unlock();
                } else if (s.mode == MODE_LISTENING && in.pressed[BSP_KEY_BACK] && cancel_cb) {
                    // Up one level from a recording is not recording. Only back does
                    // this: ok is how a hands-free note is stopped and kept.
                    cancel_cb();
                } else if (s.mode == MODE_STATUS && home) {
                    ui_push(home);
                }
            }
            // Down is the one direction the dashboard never used, so it is what
            // pulls the notification drawer down.
            if (s.mode == MODE_STATUS && in.pressed[BSP_KEY_DOWN] && drawer) ui_push(drawer);
            // Right is the other direction the dashboard never used.
            if (s.mode == MODE_STATUS && in.pressed[BSP_KEY_RIGHT] && right_app) ui_push(right_app);

            if (!dark) {
                const int64_t t = now_ms();
                background();
                switch (s.mode) {
                case MODE_BOOT:      screen_boot(s, t); break;
                case MODE_STATUS:
                    // The dashboard is the resting face of the device. It is only a
                    // painter, so every key still means what it means everywhere else.
                    if (dashboard && dashboard->paint) dashboard->paint(dashboard->ctx, cv, t);
                    else screen_status(s, t);
                    break;
                case MODE_PROMPT:    screen_prompt(s, t); break;
                case MODE_REPLY:     screen_reply(s, t); break;
                case MODE_LISTENING: screen_listening(s, t); break;
                case MODE_SENDING:   screen_sending(s, t); break;
                case MODE_ERROR:     screen_error(s, t); break;
                case MODE_RAW:       break;
                }
                bsp_display_flush();
            }
        }
        // A finished answer, or an error, eventually gives the screen back.
        lock();
        const int64_t idle_for = now_ms() - g.since;
        if (g.mode == MODE_REPLY && g.reply_done && idle_for > 20000) set_mode(g, MODE_STATUS);
        // A notice clears itself sooner: it is an aside, not something to read twice.
        if (g.mode == MODE_ERROR && idle_for > (g.error_is_notice ? 4000 : 12000)) set_mode(g, MODE_STATUS);
        if (g.mode == MODE_SENDING && idle_for > 25000) set_mode(g, MODE_STATUS);
        // The peak marker decays even while nothing is speaking.
        if (g.level_peak > 0) g.level_peak -= 0.004f;
        if (g.level_peak < 0) g.level_peak = 0;
        g.level *= 0.82f;
        unlock();

        update_backlight(now_ms());

        // A frame can overrun the budget; yield regardless, or the idle task on
        // this core never runs and the task watchdog fires. While dark the loop only
        // exists to notice a key, so it runs a fifth as often — long enough for
        // tickless idle to be worth anything, short enough that waking still feels
        // immediate.
        const int64_t spent = now_ms() - started;
        const int budget = dark ? DARK_FRAME_MS : FRAME_MS;
        const int rest = (int)(budget - spent);
        vTaskDelay(pdMS_TO_TICKS(rest > MIN_YIELD ? rest : MIN_YIELD));
    }
}

} // namespace

extern "C" {

esp_err_t ui_start(void)
{
    if (!bsp_display_available()) {
        ESP_LOGW(TAG, "no panel fitted; the interface is disabled");
        return ESP_ERR_NOT_SUPPORTED;
    }
    uidraw::cv = static_cast<LGFX_Sprite *>(bsp_display_canvas());
    if (!cv) return ESP_ERR_INVALID_STATE;
    cv->setTextDatum(textdatum_t::top_left);

    g_lock = xSemaphoreCreateMutex();
    if (!g_lock) return ESP_ERR_NO_MEM;
    g.since = now_ms();
    last_activity = g.since;
    const int at_boot = bsp_display_backlight_get();
    if (at_boot >= 0) bl_base = bl_now = at_boot;

    // Pinned away from the wifi task, and low priority: a dropped frame is nothing.
    if (xTaskCreatePinnedToCore(render_task, "ui", 5120, nullptr, 3, nullptr, 1) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    ESP_LOGI(TAG, "interface running at %d fps", FPS);
    return ESP_OK;
}

const char *ui_screen(void)
{
    if (!cv) return "none";
    // What is actually in front of the user, which is the app when one is open.
    if (depth > 0 && g.mode != MODE_RAW) return stack[depth - 1]->name;
    switch (g.mode) {
    case MODE_BOOT:      return "boot";
    case MODE_STATUS:    return dashboard ? "dashboard" : "status";
    case MODE_PROMPT:    return "prompt";
    case MODE_REPLY:     return "reply";
    case MODE_LISTENING: return "listening";
    case MODE_SENDING:   return "sending";
    case MODE_ERROR:     return g.error_is_notice ? "notice" : "error";
    case MODE_RAW:       return "drawn by a tool";
    }
    return "?";
}

bool ui_is_held(void)
{
    return cv && g.held;
}

void ui_set_brightness(int percent)
{
    bl_base = percent < 0 ? 0 : (percent > 100 ? 100 : percent);
    // Straight to the glass rather than waiting for the next frame, so dragging the
    // brightness row feels like a dimmer and not like a form you submit.
    ui_note_activity();
    bl_now = bl_base;
    bsp_display_backlight(bl_base);
}

int ui_brightness(void)
{
    return bl_base;
}

void ui_set_idle_dim(int dim_after, int blank_after)
{
    dim_after_s = dim_after < 0 ? 0 : dim_after;
    blank_after_s = blank_after < 0 ? 0 : blank_after;
    ui_note_activity();
}

void ui_note_activity(void)
{
    if (bl_now == 0) woke_from_dark = true;
    last_activity = now_ms();
}

// ── the screen stack ──────────────────────────────────────────────────────
// Only the stack itself is touched under the lock; enter() and exit() are run by
// the render task in settle_stack(), so an app never finds itself holding the ui
// mutex while it draws.

void ui_push(const ui_app_t *app)
{
    if (!app) return;
    // Asking for a screen outranks a picture a tool left behind — otherwise the
    // menu opens underneath it and the back key looks broken. It does not outrank
    // the video player, which is writing to the glass this instant.
    if (exclusive) return;
    lock();
    if (depth < STACK_MAX) {
        stack[depth++] = app;
    } else {
        // Silently dropping it is how a screen goes missing with nothing to show
        // for it, so say so. Raise STACK_MAX if this ever fires in normal use.
        ESP_LOGW(TAG, "the screen stack is full; \"%s\" was not opened", app->name);
    }
    if (g.mode == MODE_RAW) {
        g.held = false;
        set_mode(g, MODE_STATUS);
    }
    unlock();
    ui_note_activity();
}

void ui_pop(void)
{
    lock();
    if (depth > 0) depth--;
    unlock();
    ui_note_activity();
}

void ui_pop_all(void)
{
    lock();
    depth = 0;
    unlock();
}

int ui_depth(void)
{
    return depth;
}

void ui_set_home(const ui_app_t *app)
{
    home = app;
}

bool ui_exclusive(void)
{
    return exclusive;
}

void ui_go_home(void)
{
    if (home) ui_push(home);
}

void ui_set_dashboard(const ui_app_t *app)
{
    dashboard = app;
}

void ui_set_right(const ui_app_t *app)
{
    right_app = app;
}

void ui_set_drawer(const ui_app_t *app)
{
    drawer = app;
}

const char *ui_link_state(void)
{
    return g.link;
}

const char *ui_ip(void)
{
    return g.ip;
}

#define GUARD() if (!cv) return

void ui_boot(const char *step)
{
    GUARD();
    lock();
    if (step && strcmp(g.boot_step, step) != 0) {
        strlcpy(g.boot_step, step, sizeof(g.boot_step));
        if (g.boot_index < 5) g.boot_index++;
    }
    set_mode(g, MODE_BOOT);
    unlock();
}

void ui_link(const char *state, const char *ip)
{
    GUARD();
    lock();
    if (state) strlcpy(g.link, state, sizeof(g.link));
    if (ip) strlcpy(g.ip, ip, sizeof(g.ip));
    // Boot, prompts and replies all outrank a status change; only take the screen
    // if nothing more interesting is on it.
    if (!g.held && (g.mode == MODE_BOOT || g.mode == MODE_STATUS)) set_mode(g, MODE_STATUS);
    unlock();
}

void ui_prompt(const char *text, const char *origin)
{
    GUARD();
    ui_pop_all(); // a question is the terminal's business; get out of the way
    lock();
    g.held = false;
    strlcpy(g.prompt, text ? text : "", sizeof(g.prompt));
    strlcpy(g.origin, origin ? origin : "device", sizeof(g.origin));
    reset_reply(g);
    g.working[0] = '\0';
    set_mode(g, MODE_PROMPT);
    g.since = now_ms(); // a new question, so the typewriter starts again
    unlock();
}

void ui_reply_append(const char *chunk)
{
    GUARD();
    if (!chunk || !*chunk) return;
    lock();
    starting_new_reply(g);
    const size_t len = strlen(chunk);
    size_t room = sizeof(g.reply) - 1 - g.reply_len;
    if (len > room) {
        // Past the end of the buffer: drop the oldest half so the newest words live.
        const size_t keep = sizeof(g.reply) / 2;
        if (g.reply_len > keep) {
            memmove(g.reply, g.reply + g.reply_len - keep, keep);
            g.reply_len = keep;
        }
        room = sizeof(g.reply) - 1 - g.reply_len;
    }
    const size_t take = len > room ? room : len;
    memcpy(g.reply + g.reply_len, chunk, take);
    g.reply_len += take;
    g.reply[g.reply_len] = '\0';
    g.working[0] = '\0';
    if (!g.held) set_mode(g, MODE_REPLY);
    unlock();
}

void ui_reply_done(bool aborted, int in_tokens, int out_tokens)
{
    GUARD();
    lock();
    g.reply_done = true;
    g.aborted = aborted;
    g.tin = in_tokens;
    g.tout = out_tokens;
    g.working[0] = '\0';
    if (g.mode == MODE_PROMPT && !g.held) set_mode(g, MODE_REPLY);
    // The twenty seconds an answer stays up are counted from here, not from the
    // first chunk: a reply that took longer than that to stream used to vanish the
    // instant it finished.
    if (g.mode == MODE_REPLY) g.since = now_ms();
    unlock();
}

void ui_working(const char *tool)
{
    GUARD();
    lock();
    // A turn that opens with a tool call shows the spinner before any text arrives, so
    // clear here too or the last answer sits under it.
    if (tool) starting_new_reply(g);
    strlcpy(g.working, tool ? tool : "", sizeof(g.working));
    if (tool && g.mode != MODE_LISTENING && !g.held) set_mode(g, MODE_REPLY);
    unlock();
}

void ui_error(const char *msg)
{
    GUARD();
    ui_pop_all();
    lock();
    g.held = false;
    // Notices and errors share a mode, so this has to be cleared here. Leaving it
    // set meant the first "nothing was said" of a session quietly turned every real
    // error after it into a four-second amber aside.
    g.error_is_notice = false;
    strlcpy(g.error, msg ? msg : "something went wrong", sizeof(g.error));
    set_mode(g, MODE_ERROR);
    g.since = now_ms(); // a second error is a new one, however soon it arrives
    unlock();
}

void ui_notice(const char *msg)
{
    GUARD();
    // Deliberately no ui_pop_all(): if you are in the settings screen this is not
    // important enough to throw you out of it. It waits instead of being lost.
    if (depth > 0) {
        strlcpy(pending_notice, msg ? msg : "", sizeof(pending_notice));
        return;
    }
    lock();
    g.error_is_notice = true;
    g.held = false;
    strlcpy(g.error, msg ? msg : "", sizeof(g.error));
    set_mode(g, MODE_ERROR);
    // Stamped even when the mode has not changed. Without this a second notice
    // inherits the first one's age, and anything past the four-second timeout is
    // cleared on the very next frame — one flickering frame, or nothing at all.
    g.since = now_ms();
    unlock();
}

void ui_listening(int seconds)
{
    GUARD();
    ui_pop_all(); // the user started talking to it; show that, not a menu
    lock();
    g.held = false;
    g.listen_secs = seconds;
    g.listen_start = now_ms();
    g.level = g.level_peak = 0;
    set_mode(g, MODE_LISTENING);
    unlock();
}

void ui_level(float level)
{
    GUARD();
    if (level < 0) level = 0;
    if (level > 1) level = 1;
    lock();
    if (level > g.level) g.level = level;
    if (level > g.level_peak) g.level_peak = level;
    unlock();
}

void ui_on_cancel(ui_cancel_cb_t cb)
{
    cancel_cb = cb;
}

void ui_listening_done(void)
{
    GUARD();
    lock();
    // Back to the dashboard, not to whatever was last answered. A held clip goes
    // straight on to MODE_SENDING and waits there, so the only thing this decides is
    // what a released or cancelled recording leaves behind — and an old reply
    // reappearing reads as a response to what was just said.
    if (g.mode == MODE_LISTENING) set_mode(g, MODE_STATUS);
    unlock();
}

void ui_sending(void)
{
    GUARD();
    lock();
    // A fresh clip: back to "transcribing" until the server says what it is doing,
    // or the last turn's final stage would be the first thing on screen.
    g.stage[0] = 0;
    g.stage_detail[0] = 0;
    set_mode(g, MODE_SENDING);
    unlock();
}

void ui_stage(const char *label, const char *detail)
{
    GUARD();
    lock();
    // Deliberately does not change the mode. This only relabels the splash that is
    // already up; a turn typed from the dashboard is on the prompt screen and has
    // nothing to relabel, so it should not be dragged anywhere by a progress update.
    strlcpy(g.stage, label ? label : "", sizeof(g.stage));
    strlcpy(g.stage_detail, detail ? detail : "", sizeof(g.stage_detail));
    unlock();
}

// ── the display_* tools ───────────────────────────────────────────────────

// These draw once and hand the panel back to nobody: the render task stops until
// something the terminal cares about happens.
static void raw_begin()
{
    lock();
    g.held = true;
    set_mode(g, MODE_RAW);
    unlock();
    vTaskDelay(pdMS_TO_TICKS(FRAME_MS * 2)); // let the render task finish its frame
    // Anything pressed before the picture arrived was aimed at the screen it
    // replaced, and would dismiss this one the moment it appeared.
    bsp_keys_flush();
    // A frame smaller than the panel leaves a border, and whatever the interface last
    // drew would sit in it.
    bsp_display_clear();
}

void ui_raw_message(const char *title, const char *body, ui_tone_t tone, int scale)
{
    GUARD();
    raw_begin();
    const uint32_t accent = tone_color(tone);
    const int w = cv->width();

    background();
    const lgfx::GFXfont *font = scale >= 3   ? &fonts::FreeMonoBold18pt7b
                                : scale == 2 ? &fonts::FreeMonoBold12pt7b
                                             : &fonts::FreeMono9pt7b;
    const int line_h = scale >= 3 ? 34 : scale == 2 ? 24 : 20;
    int y = 10;

    if (title && *title) {
        cv->fillRect(0, 0, w, 2, accent);
        cv->setFont(&fonts::FreeMono9pt7b);
        cv->setTextColor(accent);
        cv->drawString(title, 10, 10);
        y = 38;
    }
    cv->setFont(font);
    if (body && *body) text_block(body, 10, y, w - 20, cv->height() - 8, title && *title ? FG : accent, line_h, -1);
    bsp_display_flush();
}

void ui_raw_fill(uint8_t r, uint8_t gg, uint8_t b)
{
    GUARD();
    raw_begin();
    cv->fillScreen(((uint32_t)r << 16) | ((uint32_t)gg << 8) | b);
    bsp_display_flush();
}

bool ui_raw_pattern(const char *name)
{
    if (!cv) return false;
    const int w = cv->width(), h = cv->height();

    if (!strcmp(name, "grid")) {
        raw_begin();
        cv->fillScreen(BG);
        for (int x = 0; x < w; x += 20) cv->drawFastVLine(x, 0, h, AMBER_DIM);
        for (int y = 0; y < h; y += 20) cv->drawFastHLine(0, y, w, AMBER_DIM);
        cv->drawRect(0, 0, w, h, AMBER);
        cv->drawRect(1, 1, w - 2, h - 2, AMBER);
    } else if (!strcmp(name, "gradient")) {
        raw_begin();
        for (int y = 0; y < h; y++) {
            const uint32_t v = (uint32_t)(y * 255 / (h - 1));
            cv->drawFastHLine(0, y, w, (v << 16) | (v << 8) | v);
        }
    } else if (!strcmp(name, "bars")) {
        raw_begin();
        static const uint32_t BARS[] = {0xFFFFFF, 0xFFFF00, 0x00FFFF, 0x00FF00, 0xFF00FF, 0xFF0000, 0x0000FF, 0x000000};
        const int n = sizeof(BARS) / sizeof(BARS[0]);
        for (int i = 0; i < n; i++) cv->fillRect(i * w / n, 0, w / n + 1, h, BARS[i]);
    } else {
        return false;
    }
    bsp_display_flush();
    return true;
}

bool ui_raw_image(const uint8_t *jpeg, size_t len)
{
    if (!cv || !jpeg || len == 0) return false;
    raw_begin();
    cv->fillScreen(TFT_BLACK);
    // The server sized it for this panel, so it lands 1:1 and nothing is scaled twice.
    const bool ok = cv->drawJpg(jpeg, len, 0, 0, cv->width(), cv->height());
    if (!ok) {
        // Reported through the error screen rather than drawn raw. Drawn raw it would
        // sit in MODE_RAW with nothing to release it, so a picture that failed to
        // decode wedged the panel until the agent next spoke.
        ui_raw_release();
        ui_error("that image would not decode");
        return false;
    }
    bsp_display_flush();
    return true;
}

// ── video ─────────────────────────────────────────────────────────────────

void ui_take_panel(void)
{
    GUARD();
    // Video and the display tools draw straight to the glass. Clearing the stack
    // here is what stops an app tearing against them, and it means no caller has to
    // remember to close the shell first.
    ui_pop_all();
    lock();
    g.held = true;
    exclusive = true;
    set_mode(g, MODE_RAW);
    unlock();
    vTaskDelay(pdMS_TO_TICKS(FRAME_MS * 2)); // let the render task finish its frame
}

void ui_give_panel(void)
{
    GUARD();
    // Keys pressed during playback went to on_key, not to poll_keys, so the queue is
    // full of edges that have already been acted on. Dropping them stops the film
    // ending in a burst of navigation.
    bsp_keys_flush();
    woke_from_dark = false;
    lock();
    exclusive = false;
    g.held = false;
    set_mode(g, MODE_STATUS);
    unlock();
}

// Decoded straight to the panel rather than into the canvas: measured at 60 ms a
// frame against 87 ms through the sprite, because it avoids writing 115 KB into
// PSRAM and reading it straight back out.
bool ui_video_present(const uint8_t *jpeg, size_t len, int x, int y)
{
    if (!cv || !jpeg || !len) return false;
    // A film playing is not an idle screen, even though nobody is touching a key.
    ui_note_activity();
    return bsp_display_draw_jpeg(jpeg, len, x, y);
}

void ui_raw_release(void)
{
    GUARD();
    lock();
    g.held = false;
    if (g.mode == MODE_RAW) set_mode(g, MODE_STATUS);
    unlock();
}

} // extern "C"
