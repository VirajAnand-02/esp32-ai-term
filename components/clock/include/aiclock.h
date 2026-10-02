#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <time.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

// What time it is, and the timezone to show it in.
//
// Two sources, because neither alone is enough. SNTP is authoritative but takes a
// few seconds and needs the internet, so a LAN with no route out would never know
// the time at all. The server's clock arrives with the welcome frame, which is
// instant and works on an isolated network but is only as good as the server. So:
// whichever lands first is used, and SNTP corrects it when it arrives.
//
// Named aiclock rather than clock because <time.h> already has a clock().

esp_err_t aiclock_init(void);   // reads the stored timezone; call after NVS
void aiclock_start_sntp(void);  // once wifi is up

// The server's clock, from the welcome frame. Ignored once SNTP has spoken, since
// SNTP is the better source and disagreeing with it would make the time jump.
void aiclock_set_from_server(time_t utc);

bool aiclock_ready(void);       // has any source set the time yet
bool aiclock_synced(void);      // ... and was it SNTP
time_t aiclock_now(void);
void aiclock_local(struct tm *out);

// A POSIX TZ string, e.g. "IST-5:30" or "GMT0BST,M3.5.0/1,M10.5.0". The server
// sends its own on connect, so the device usually never has to be told.
void aiclock_set_tz(const char *tz);
const char *aiclock_tz(void);

// "2:32" and "Mon 29 Sep", both into the caller's buffer. Twelve hour, with no
// leading zero on the hour, because that is how the time gets read aloud.
void aiclock_time_str(char *out, size_t n, bool with_seconds);
void aiclock_date_str(char *out, size_t n);

// "am" or "pm", kept separate so a big clock can set it small beside the digits
// rather than making the whole string wider. Empty until the clock is set.
const char *aiclock_ampm(void);

// "2:32 pm", for a log line or a sentence where the two belong together.
void aiclock_time_ampm(char *out, size_t n, bool with_seconds);

// Formats any hour and minute the same way, for an alarm that is not "now".
void aiclock_format_hm(int hour, int minute, char *out, size_t n);

#ifdef __cplusplus
}
#endif
