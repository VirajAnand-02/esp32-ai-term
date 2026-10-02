#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs.h"

#include "aiclock.h"
#include "schedule.h"

static const char *TAG = "sched";

#define NAMESPACE "aiclock"
#define BLOB_KEY  "sched"
#define BLOB_VERSION 1

// A list of records, so one blob rather than a key each. Versioned because the
// shape will change the first time something is added to it, and a blob read back
// into a struct that has grown is silent corruption rather than an error.
typedef struct {
    uint8_t version;
    uint8_t count;
    uint32_t next_id;
    sched_entry_t items[SCHED_MAX];
} store_t;

static store_t s;
static SemaphoreHandle_t s_lock;
static esp_timer_handle_t s_tick;
static sched_fire_t s_on_fire;

static void lock(void)
{
    if (s_lock) xSemaphoreTake(s_lock, portMAX_DELAY);
}

static void unlock(void)
{
    if (s_lock) xSemaphoreGive(s_lock);
}

static void save_locked(void)
{
    nvs_handle_t h;
    if (nvs_open(NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_blob(h, BLOB_KEY, &s, sizeof(s));
    nvs_commit(h);
    nvs_close(h);
}

// The next time this alarm's hour:minute comes round on one of its days.
static time_t next_alarm_time(const sched_entry_t *e, time_t after)
{
    struct tm tm;
    localtime_r(&after, &tm);
    tm.tm_sec = 0;

    for (int day = 0; day <= 8; day++) {
        struct tm probe = tm;
        probe.tm_mday += day;
        probe.tm_hour = e->hour;
        probe.tm_min = e->minute;
        probe.tm_isdst = -1;      // let mktime work out DST for that date
        const time_t when = mktime(&probe);
        if (when <= after) continue;

        if (e->days == 0) return when; // one shot: the next time it comes round
        struct tm at;
        localtime_r(&when, &at);
        if (e->days & (1 << at.tm_wday)) return when;
    }
    return 0;
}

static void reschedule_locked(sched_entry_t *e, time_t now)
{
    if (e->kind == SCHED_ALARM) {
        e->fires_at = next_alarm_time(e, now);
    }
}

// Works out afresh when everything is due, and throws away whatever cannot happen
// any more. Returns how many were dropped.
//
// This runs when the clock is set, not when the device boots, and that distinction
// is the whole point. At boot the clock is very often 1970: the RTC does not
// survive a power cut and SNTP has not answered yet. Scheduling a daily 10:00
// alarm against 1970 puts its next firing decades in the past, so the instant the
// real time arrives it is overdue and goes off — which is exactly the "it rings
// when I plug it in" problem.
static int resync_locked(time_t now)
{
    int kept = 0;
    for (int i = 0; i < s.count; i++) {
        sched_entry_t *e = &s.items[i];
        if (e->kind == SCHED_ALARM && e->days) {
            // Repeating: always the next occurrence strictly after now, so one that
            // came and went while the device was off simply waits for tomorrow.
            e->fires_at = next_alarm_time(e, now);
        } else if (e->fires_at == 0 || e->fires_at <= now) {
            // A timer, or a one-shot alarm, whose moment has already passed. Firing
            // it late is worse than not firing it at all.
            continue;
        }
        s.items[kept++] = *e;
    }
    const int dropped = s.count - kept;
    s.count = (uint8_t)kept;
    return dropped;
}

// What the clock said last tick, for spotting it being set rather than just running.
static time_t s_last_seen;

static void tick(void *arg)
{
    if (!aiclock_ready()) return; // nothing is due until we know what time it is
    const time_t now = aiclock_now();

    // A once-a-second tick should never see the clock move by more than a second or
    // two. Anything larger is the clock being *set* — SNTP answering, the server's
    // time arriving, or a correction — and every firing time worked out before it
    // was worked out against the wrong clock. Recompute them, and deliberately fire
    // nothing on this tick: the jump itself must not look like things coming due.
    if (s_last_seen == 0 || now < s_last_seen || now - s_last_seen > 30) {
        const bool first = s_last_seen == 0;
        s_last_seen = now;
        lock();
        const int dropped = resync_locked(now);
        if (dropped) save_locked();
        unlock();
        ESP_LOGI(TAG, "clock %s; rescheduled, %d dropped as already past",
                 first ? "arrived" : "corrected", dropped);
        return;
    }
    s_last_seen = now;

    // Collected under the lock and fired outside it: the callback draws and plays
    // sounds, and holding a mutex across that invites a deadlock for no reason.
    sched_entry_t fired[SCHED_MAX];
    int n = 0;

    lock();
    for (int i = 0; i < s.count;) {
        sched_entry_t *e = &s.items[i];
        if (!e->enabled || e->fires_at == 0 || e->fires_at > now) {
            i++;
            continue;
        }
        fired[n++] = *e;
        if (e->kind == SCHED_TIMER || e->days == 0) {
            // Spent: a timer and a one-shot alarm both go away once they have gone
            // off, rather than sitting in the list as something already over.
            memmove(&s.items[i], &s.items[i + 1], sizeof(sched_entry_t) * (size_t)(s.count - i - 1));
            s.count--;
        } else {
            reschedule_locked(e, now);
            i++;
        }
    }
    if (n) save_locked();
    unlock();

    for (int i = 0; i < n; i++) {
        ESP_LOGI(TAG, "firing \"%s\"", fired[i].label);
        if (s_on_fire) s_on_fire(&fired[i]);
    }
}

esp_err_t sched_init(void)
{
    s_lock = xSemaphoreCreateMutex();
    if (!s_lock) return ESP_ERR_NO_MEM;

    nvs_handle_t h;
    bool loaded = false;
    if (nvs_open(NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        size_t len = sizeof(s);
        if (nvs_get_blob(h, BLOB_KEY, &s, &len) == ESP_OK && len == sizeof(s) && s.version == BLOB_VERSION) {
            loaded = true;
        }
        nvs_close(h);
    }
    if (!loaded) {
        memset(&s, 0, sizeof(s));
        s.version = BLOB_VERSION;
        s.next_id = 1;
    }
    if (s.count > SCHED_MAX) s.count = SCHED_MAX;
    if (s.next_id == 0) s.next_id = 1;

    // Nothing is scheduled here on purpose. This runs before wifi, so the clock is
    // usually still 1970, and anything worked out against it would be wrong. The
    // first tick after the clock is trustworthy does it instead.

    const esp_timer_create_args_t args = {.callback = tick, .name = "sched"};
    if (esp_timer_create(&args, &s_tick) == ESP_OK) {
        esp_timer_start_periodic(s_tick, 1000 * 1000); // once a second is plenty
    }
    ESP_LOGI(TAG, "%d loaded; waiting for the clock before working out what is due", s.count);
    return ESP_OK;
}

int sched_count(void)
{
    return s.count;
}

const sched_entry_t *sched_at(int index)
{
    return index >= 0 && index < s.count ? &s.items[index] : NULL;
}

const sched_entry_t *sched_find(uint32_t id)
{
    for (int i = 0; i < s.count; i++) {
        if (s.items[i].id == id) return &s.items[i];
    }
    return NULL;
}

static uint32_t add(const sched_entry_t *proto)
{
    lock();
    if (s.count >= SCHED_MAX) {
        unlock();
        ESP_LOGW(TAG, "no room; %d is the limit", SCHED_MAX);
        return 0;
    }
    sched_entry_t *e = &s.items[s.count++];
    *e = *proto;
    e->id = s.next_id++;
    e->enabled = true;
    save_locked();
    const uint32_t id = e->id;
    unlock();
    return id;
}

uint32_t sched_add_timer(int seconds, const char *label, const char *prompt)
{
    if (seconds <= 0) return 0;
    sched_entry_t e = {0};
    e.kind = SCHED_TIMER;
    e.fires_at = aiclock_now() + seconds;
    strlcpy(e.label, label && *label ? label : "timer", sizeof(e.label));
    if (prompt) strlcpy(e.prompt, prompt, sizeof(e.prompt));
    return add(&e);
}

uint32_t sched_add_alarm(int hour, int minute, uint8_t days, const char *label, const char *prompt)
{
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return 0;
    sched_entry_t e = {0};
    e.kind = SCHED_ALARM;
    e.hour = (int8_t)hour;
    e.minute = (int8_t)minute;
    e.days = days & SCHED_EVERY_DAY;
    e.fires_at = next_alarm_time(&e, aiclock_now());
    strlcpy(e.label, label && *label ? label : "alarm", sizeof(e.label));
    if (prompt) strlcpy(e.prompt, prompt, sizeof(e.prompt));
    return add(&e);
}

bool sched_cancel(uint32_t id)
{
    bool found = false;
    lock();
    for (int i = 0; i < s.count; i++) {
        if (s.items[i].id != id) continue;
        memmove(&s.items[i], &s.items[i + 1], sizeof(sched_entry_t) * (size_t)(s.count - i - 1));
        s.count--;
        found = true;
        save_locked();
        break;
    }
    unlock();
    return found;
}

bool sched_enable(uint32_t id, bool on)
{
    bool found = false;
    lock();
    for (int i = 0; i < s.count; i++) {
        if (s.items[i].id != id) continue;
        s.items[i].enabled = on;
        // A re-enabled alarm should go off next time it comes round, not at the
        // moment in the past it was switched off before.
        if (on) reschedule_locked(&s.items[i], aiclock_now());
        found = true;
        save_locked();
        break;
    }
    unlock();
    return found;
}

int sched_seconds_left(const sched_entry_t *e)
{
    if (!e || e->fires_at == 0) return 0;
    const int left = (int)(e->fires_at - aiclock_now());
    return left > 0 ? left : 0;
}

static const char *const DAY_NAME[7] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};

void sched_describe(const sched_entry_t *e, char *out, size_t n)
{
    if (!e) {
        strlcpy(out, "", n);
        return;
    }
    if (e->kind == SCHED_TIMER) {
        const int left = sched_seconds_left(e);
        if (left >= 3600) snprintf(out, n, "%d:%02d:%02d left", left / 3600, (left / 60) % 60, left % 60);
        else snprintf(out, n, "%d:%02d left", left / 60, left % 60);
        return;
    }
    char when[16];
    if (e->days == 0) strlcpy(when, "once", sizeof(when));
    else if (e->days == SCHED_EVERY_DAY) strlcpy(when, "daily", sizeof(when));
    else if (e->days == SCHED_WEEKDAYS) strlcpy(when, "Mon-Fri", sizeof(when));
    else {
        // Whichever days they are, listed. Three letters each is too wide for the
        // panel, so it is the first letter of each.
        size_t w = 0;
        for (int d = 0; d < 7 && w + 1 < sizeof(when); d++) {
            if (e->days & (1 << d)) when[w++] = DAY_NAME[d][0];
        }
        when[w] = '\0';
    }
    char hm[16];
    aiclock_format_hm(e->hour, e->minute, hm, sizeof(hm));
    snprintf(out, n, "%s %s", hm, when);
}

void sched_on_fire(sched_fire_t cb)
{
    s_on_fire = cb;
}
