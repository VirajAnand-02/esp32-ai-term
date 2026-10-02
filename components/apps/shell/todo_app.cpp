#include "shell_internal.hpp"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs.h"
#include "shell.h"

#include "aiclock.h"
#include "text_entry.hpp"

// Todos, in two lists: the ones that come back every day and everything else.
//
// Right from the dashboard opens the daily list, and right again crosses to the
// rest — the owner's own route through it. Back leaves. A daily todo is not a
// separate kind of record, only a flag: ticking one stamps the day it was ticked,
// and the next day it clears itself. That way "water the plants" is one row for
// ever instead of one row per day.
//
// Stored as a single NVS blob, following components/proto/wifi_store.c. Writes
// happen on mutation only — never from paint, which runs fifteen times a second
// and would otherwise wear the flash out.

static const char *TAG = "todo";

namespace shell {
namespace {

constexpr int TODO_MAX = 32;
constexpr int TODO_TEXT = 40;

#define TODO_NAMESPACE "todos"
#define TODO_BLOB_KEY  "list"
#define TODO_VERSION   1

struct todo_t {
    char text[TODO_TEXT];
    bool used;
    bool daily;
    bool done;
    // Which day it was last ticked, as year*1000 + day-of-year. Only meaningful for
    // a daily: it is what the reset compares against. 0 means "ticked with no clock".
    int32_t done_day;
};

struct blob_t {
    uint32_t version;
    todo_t items[TODO_MAX];
};

blob_t s;
SemaphoreHandle_t s_lock;

void lock()
{
    if (s_lock) xSemaphoreTake(s_lock, portMAX_DELAY);
}

void unlock()
{
    if (s_lock) xSemaphoreGive(s_lock);
}

// Callers hold the lock.
void save_locked()
{
    nvs_handle_t h;
    if (nvs_open(TODO_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return;
    if (nvs_set_blob(h, TODO_BLOB_KEY, &s, sizeof(s)) == ESP_OK) nvs_commit(h);
    nvs_close(h);
}

/** year*1000 + day-of-year, or 0 while the clock has not been set yet. */
int32_t today_key()
{
    // Before SNTP the clock reads 1970, and resetting every daily against that would
    // wipe the ticks the moment real time arrived. Same trap as the 1970 alarm.
    if (!aiclock_ready()) return 0;
    struct tm tm;
    aiclock_local(&tm);
    return (int32_t)(tm.tm_year + 1900) * 1000 + tm.tm_yday;
}

// Un-ticks any daily todo that was ticked on an earlier day. Cheap enough to call
// from paint; only writes when something actually changed.
void refresh_daily_locked()
{
    const int32_t today = today_key();
    if (!today) return;
    bool changed = false;
    for (int i = 0; i < TODO_MAX; i++) {
        todo_t &it = s.items[i];
        if (!it.used || !it.daily || !it.done) continue;
        if (it.done_day != today) {
            it.done = false;
            changed = true;
        }
    }
    if (changed) save_locked();
}

/** Indices of the live rows in one list, in slot order. Returns how many. */
int collect(bool daily, int *out, int max)
{
    int n = 0;
    for (int i = 0; i < TODO_MAX && n < max; i++) {
        if (s.items[i].used && s.items[i].daily == daily) out[n++] = i;
    }
    return n;
}

int free_slot()
{
    for (int i = 0; i < TODO_MAX; i++) {
        if (!s.items[i].used) return i;
    }
    return -1;
}

// ── the screen ────────────────────────────────────────────────────────────

bool view_daily = true; // which list is showing; right crosses between them
int sel;
int top;

void todo_enter(void *)
{
    // Always opens on the daily list: that is what right from the dashboard means.
    view_daily = true;
    sel = 0;
    top = 0;
    lock();
    refresh_daily_locked();
    unlock();
}

void added(const char *text, void *)
{
    if (!text || !text[0]) return; // back out of the editor adds nothing
    lock();
    const int slot = free_slot();
    if (slot < 0) {
        unlock();
        ui_error("the todo list is full");
        return;
    }
    todo_t &it = s.items[slot];
    memset(&it, 0, sizeof(it));
    strlcpy(it.text, text, sizeof(it.text));
    it.used = true;
    it.daily = view_daily;
    save_locked();
    unlock();
    ESP_LOGI(TAG, "added \"%s\"%s", text, view_daily ? " (daily)" : "");
}

void todo_input(void *, const ui_input_t *in)
{
    if (in->pressed[BSP_KEY_BACK]) {
        ui_pop();
        return;
    }

    int idx[TODO_MAX];
    lock();
    const int n = collect(view_daily, idx, TODO_MAX);
    unlock();

    const int rows = n + 1; // the last row adds one
    sel = move_sel(sel, rows, in);

    // Right crosses to the other list. The selection starts again rather than being
    // carried over: the lists are different lengths and the same row number in each
    // means nothing.
    if (in->pressed[BSP_KEY_RIGHT]) {
        view_daily = !view_daily;
        sel = 0;
        top = 0;
        return;
    }

    if (in->pressed[BSP_KEY_OK]) {
        if (sel >= n) {
            text_entry_open(view_daily ? "daily todo" : "todo", "", TODO_TEXT - 1, added, nullptr);
            return;
        }
        lock();
        todo_t &it = s.items[idx[sel]];
        it.done = !it.done;
        it.done_day = it.done ? today_key() : 0;
        save_locked();
        unlock();
        return;
    }

    // Left deletes, the same key the alarms list uses for it — destructive enough to
    // want its own key rather than hiding behind a long press of ok.
    if (in->pressed[BSP_KEY_LEFT] && sel < n) {
        lock();
        memset(&s.items[idx[sel]], 0, sizeof(todo_t));
        save_locked();
        unlock();
        if (sel > 0 && sel >= n - 1) sel--;
    }

    top = scroll_to(sel, top, rows);
}

void todo_paint(void *, void *, int64_t)
{
    lock();
    refresh_daily_locked();
    int idx[TODO_MAX];
    const int n = collect(view_daily, idx, TODO_MAX);

    // Copied out under the lock so the drawing below touches no shared state.
    struct row_t {
        char text[TODO_TEXT];
        bool done;
    } rows_buf[ROWS_VISIBLE];
    const int rows = n + 1;
    const int first = top;
    int shown = 0;
    for (int i = first; i < n && shown < ROWS_VISIBLE; i++) {
        strlcpy(rows_buf[shown].text, s.items[idx[i]].text, TODO_TEXT);
        rows_buf[shown].done = s.items[idx[i]].done;
        shown++;
    }
    int left_todo = 0;
    for (int i = 0; i < n; i++) {
        if (!s.items[idx[i]].done) left_todo++;
    }
    unlock();

    title(view_daily ? "daily" : "todos");

    for (int i = 0; i < shown; i++) {
        const int row = first + i;
        list_row(LIST_TOP + i * ROW_H, rows_buf[i].text, rows_buf[i].done ? "x" : nullptr, row == sel);
    }
    // The add row, when it is on screen.
    if (first + shown >= n && shown < ROWS_VISIBLE) {
        list_row(LIST_TOP + shown * ROW_H, view_daily ? "+ daily todo" : "+ todo", nullptr, sel >= n);
    }
    scrollbar(top, rows);

    if (n == 0) {
        small();
        text_centered(view_daily ? "nothing daily yet" : "nothing on the list", 120, AMBER_FAINT);
    }

    if (sel >= n) {
        hint(view_daily ? "ok adds  ·  right: all todos" : "ok adds  ·  right: daily");
    } else {
        char line[48];
        snprintf(line, sizeof(line), "%d left  ·  left deletes", left_todo);
        hint(line);
    }
}

} // namespace

const ui_app_t todo_app = {"todos", todo_enter, todo_input, todo_paint, nullptr, nullptr};

void todo_init()
{
    s_lock = xSemaphoreCreateMutex();

    nvs_handle_t h;
    bool loaded = false;
    if (nvs_open(TODO_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        size_t len = sizeof(s);
        if (nvs_get_blob(h, TODO_BLOB_KEY, &s, &len) == ESP_OK && len == sizeof(s) && s.version == TODO_VERSION) {
            loaded = true;
        }
        nvs_close(h);
    }
    if (!loaded) {
        memset(&s, 0, sizeof(s));
        s.version = TODO_VERSION;
    }

    int n = 0;
    for (int i = 0; i < TODO_MAX; i++) {
        if (s.items[i].used) n++;
    }
    ESP_LOGI(TAG, "%d todo%s", n, n == 1 ? "" : "s");
}


// ── the console's view ────────────────────────────────────────────────────
// A flat index over both lists, daily first, so /todo can drive this over the
// serial cable like every other screen. Same reason /key and /screen exist:
// nobody in the loop can see the panel.

namespace {

// Resolves a flat index (every daily, then the rest) to a slot, or -1.
// Callers hold the lock.
int slot_for(int index)
{
    int seen = 0;
    for (int pass = 0; pass < 2; pass++) {
        const bool daily = pass == 0;
        for (int i = 0; i < TODO_MAX; i++) {
            const todo_t &it = s.items[i];
            if (!it.used || it.daily != daily) continue;
            if (seen == index) return i;
            seen++;
        }
    }
    return -1;
}

} // namespace

extern "C" int shell_todo_total(void)
{
    lock();
    refresh_daily_locked();
    int n = 0;
    for (int i = 0; i < TODO_MAX; i++) {
        if (s.items[i].used) n++;
    }
    unlock();
    return n;
}

extern "C" void shell_todo_describe(int index, char *out, size_t n)
{
    if (!out || n == 0) return;
    out[0] = '\0';
    lock();
    const int slot = slot_for(index);
    if (slot >= 0) {
        const todo_t &it = s.items[slot];
        snprintf(out, n, "[%c] %s%s", it.done ? 'x' : ' ', it.daily ? "daily  " : "", it.text);
    }
    unlock();
}

extern "C" bool shell_todo_add(const char *text, bool daily)
{
    if (!text || !text[0]) return false;
    lock();
    const int slot = free_slot();
    if (slot < 0) {
        unlock();
        return false;
    }
    todo_t &it = s.items[slot];
    memset(&it, 0, sizeof(it));
    strlcpy(it.text, text, sizeof(it.text));
    it.used = true;
    it.daily = daily;
    save_locked();
    unlock();
    return true;
}

extern "C" bool shell_todo_toggle_at(int index)
{
    lock();
    const int slot = slot_for(index);
    if (slot < 0) {
        unlock();
        return false;
    }
    todo_t &it = s.items[slot];
    it.done = !it.done;
    it.done_day = it.done ? today_key() : 0;
    save_locked();
    unlock();
    return true;
}

extern "C" bool shell_todo_delete_at(int index)
{
    lock();
    const int slot = slot_for(index);
    if (slot < 0) {
        unlock();
        return false;
    }
    memset(&s.items[slot], 0, sizeof(todo_t));
    save_locked();
    unlock();
    return true;
}

} // namespace shell
