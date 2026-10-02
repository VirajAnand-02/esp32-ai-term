#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <time.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

// Timers, alarms and scheduled prompts.
//
// One record type for all three, because they only differ in how the next firing
// time is worked out: a timer counts down from now, an alarm is a wall-clock time
// that may repeat on chosen days, and either becomes a "scheduled prompt" simply by
// carrying text for the agent to answer instead of just making a noise.

#define SCHED_MAX 12
#define SCHED_LABEL 28
#define SCHED_PROMPT 96

typedef enum {
    SCHED_TIMER, // counts down once, then is gone
    SCHED_ALARM, // a time of day, repeating on `days` or one-shot
} sched_kind_t;

typedef struct {
    uint32_t id;
    uint8_t kind;
    bool enabled;
    int8_t hour, minute; // alarms only
    uint8_t days;        // bit 0 Sunday .. bit 6 Saturday; 0 means one shot
    time_t fires_at;     // absolute, always kept current
    char label[SCHED_LABEL];
    char prompt[SCHED_PROMPT]; // non-empty: the agent answers this when it fires
} sched_entry_t;

#define SCHED_EVERY_DAY  0x7F
#define SCHED_WEEKDAYS   0x3E // Mon-Fri

esp_err_t sched_init(void); // after NVS and aiclock_init

int sched_count(void);
const sched_entry_t *sched_at(int index);
const sched_entry_t *sched_find(uint32_t id);

// All three return the new id, or 0 if there was no room. `prompt` may be NULL.
uint32_t sched_add_timer(int seconds, const char *label, const char *prompt);
uint32_t sched_add_alarm(int hour, int minute, uint8_t days, const char *label, const char *prompt);

bool sched_cancel(uint32_t id);
bool sched_enable(uint32_t id, bool on);

// "4:12 left" for a timer, "07:00 Mon-Fri" for an alarm.
void sched_describe(const sched_entry_t *e, char *out, size_t n);
int sched_seconds_left(const sched_entry_t *e);

// Called from a timer task when something comes due. Keep it short: start a sound,
// set a screen, hand a prompt off — do not block in here.
typedef void (*sched_fire_t)(const sched_entry_t *entry);
void sched_on_fire(sched_fire_t cb);

#ifdef __cplusplus
}
#endif
