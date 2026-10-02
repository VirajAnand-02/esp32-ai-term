#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>

#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "nvs.h"

#include "aiclock.h"

static const char *TAG = "clock";

#define NAMESPACE "aiclock"
#define TZ_KEY    "tz"

// Somewhere plausible until the server says otherwise. The device is in IST and a
// wrong offset is more confusing than an obviously unset clock, so this is only
// what an un-configured board falls back to.
#define TZ_DEFAULT "IST-5:30"

static char s_tz[48] = TZ_DEFAULT;
static bool s_ready;
static bool s_synced; // SNTP has spoken, so the server's guess is no longer wanted

static void apply_tz(void)
{
    setenv("TZ", s_tz, 1);
    tzset();
}

static void on_sntp(struct timeval *tv)
{
    s_ready = true;
    s_synced = true;
    char now[32];
    aiclock_time_str(now, sizeof(now), true);
    ESP_LOGI(TAG, "sntp: %s %s", now, s_tz);
}

esp_err_t aiclock_init(void)
{
    nvs_handle_t h;
    if (nvs_open(NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        size_t len = sizeof(s_tz);
        nvs_get_str(h, TZ_KEY, s_tz, &len); // absent just leaves the default
        nvs_close(h);
    }
    apply_tz();

    // A time before the firmware was written cannot be real, so anything below it
    // means nothing has set the clock yet. The RTC survives a soft reset, which is
    // why this is worth checking rather than assuming zero.
    s_ready = time(NULL) > 1735689600; // 2025-01-01
    ESP_LOGI(TAG, "timezone %s, clock %s", s_tz, s_ready ? "kept across reset" : "not set yet");
    return ESP_OK;
}

void aiclock_start_sntp(void)
{
    esp_sntp_config_t cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    cfg.start = true;
    cfg.sync_cb = on_sntp;
    const esp_err_t err = esp_netif_sntp_init(&cfg);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(TAG, "sntp did not start: %s", esp_err_to_name(err));
    }
}

void aiclock_set_from_server(time_t utc)
{
    if (s_synced) return; // SNTP is the better source; do not make the clock jump
    if (utc < 1735689600) return;
    const struct timeval tv = {.tv_sec = utc, .tv_usec = 0};
    settimeofday(&tv, NULL);
    s_ready = true;
    char now[32];
    aiclock_time_str(now, sizeof(now), true);
    ESP_LOGI(TAG, "time from the server: %s", now);
}

bool aiclock_ready(void)
{
    return s_ready;
}

bool aiclock_synced(void)
{
    return s_synced;
}

time_t aiclock_now(void)
{
    return time(NULL);
}

void aiclock_local(struct tm *out)
{
    const time_t now = time(NULL);
    localtime_r(&now, out);
}

void aiclock_set_tz(const char *tz)
{
    if (!tz || !*tz || strcmp(tz, s_tz) == 0) return;
    strlcpy(s_tz, tz, sizeof(s_tz));
    apply_tz();

    nvs_handle_t h;
    if (nvs_open(NAMESPACE, NVS_READWRITE, &h) == ESP_OK) {
        nvs_set_str(h, TZ_KEY, s_tz);
        nvs_commit(h);
        nvs_close(h);
    }
    ESP_LOGI(TAG, "timezone is now %s", s_tz);
}

const char *aiclock_tz(void)
{
    return s_tz;
}

void aiclock_time_str(char *out, size_t n, bool with_seconds)
{
    if (!s_ready) {
        strlcpy(out, with_seconds ? "--:--:--" : "--:--", n);
        return;
    }
    struct tm tm;
    aiclock_local(&tm);
    // %I would give "02:32"; the leading zero is noise on a clock face, so the hour
    // is formatted by hand and only the minutes and seconds are padded.
    const int h12 = tm.tm_hour % 12 == 0 ? 12 : tm.tm_hour % 12;
    if (with_seconds) snprintf(out, n, "%d:%02d:%02d", h12, tm.tm_min, tm.tm_sec);
    else snprintf(out, n, "%d:%02d", h12, tm.tm_min);
}

const char *aiclock_ampm(void)
{
    if (!s_ready) return "";
    struct tm tm;
    aiclock_local(&tm);
    return tm.tm_hour < 12 ? "am" : "pm";
}

void aiclock_time_ampm(char *out, size_t n, bool with_seconds)
{
    char t[16];
    aiclock_time_str(t, sizeof(t), with_seconds);
    if (!s_ready) {
        strlcpy(out, t, n);
        return;
    }
    snprintf(out, n, "%s %s", t, aiclock_ampm());
}

void aiclock_format_hm(int hour, int minute, char *out, size_t n)
{
    const int h12 = hour % 12 == 0 ? 12 : hour % 12;
    snprintf(out, n, "%d:%02d %s", h12, minute, hour < 12 ? "am" : "pm");
}

void aiclock_date_str(char *out, size_t n)
{
    if (!s_ready) {
        strlcpy(out, "no date yet", n);
        return;
    }
    struct tm tm;
    aiclock_local(&tm);
    strftime(out, n, "%a %d %b", &tm);
}
