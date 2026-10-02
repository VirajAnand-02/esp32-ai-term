#include <stdio.h>
#include <string.h>

#include "cJSON.h"

#include "aiclock.h"
#include "schedule.h"
#include "time_tools.h"

// The agent's side of the clock. "Set a timer for ten minutes" is the single most
// natural thing to say to a terminal you can already talk to, so these are device
// tools rather than server ones: the schedule lives here and survives the server
// going away.

static int arg_int(const cJSON *args, const char *name, int fallback)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(args, name);
    return cJSON_IsNumber(v) ? (int)v->valuedouble : fallback;
}

static const char *arg_str(const cJSON *args, const char *name)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(args, name);
    return cJSON_IsString(v) ? v->valuestring : NULL;
}

// "mon,tue" or "weekdays" or "daily" → the bitmask. Empty means one shot.
static uint8_t parse_days(const char *spec)
{
    if (!spec || !*spec) return 0;
    if (strstr(spec, "daily") || strstr(spec, "every")) return SCHED_EVERY_DAY;
    if (strstr(spec, "weekday")) return SCHED_WEEKDAYS;
    if (strstr(spec, "weekend")) return 0x41; // Sunday and Saturday

    static const char *const NAMES[7] = {"sun", "mon", "tue", "wed", "thu", "fri", "sat"};
    uint8_t mask = 0;
    for (int d = 0; d < 7; d++) {
        if (strstr(spec, NAMES[d])) mask |= (uint8_t)(1 << d);
    }
    return mask;
}

static bool tool_set_timer(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len)
{
    const int seconds = arg_int(args, "seconds", 0) + arg_int(args, "minutes", 0) * 60 +
                        arg_int(args, "hours", 0) * 3600;
    if (seconds <= 0) {
        snprintf(err, err_len, "say how long: seconds, minutes or hours");
        return false;
    }
    if (!aiclock_ready()) {
        snprintf(err, err_len, "the clock is not set yet, so nothing can be scheduled");
        return false;
    }
    const char *label = arg_str(args, "label");
    const uint32_t id = sched_add_timer(seconds, label, arg_str(args, "prompt"));
    if (!id) {
        snprintf(err, err_len, "no room; cancel something first");
        return false;
    }
    snprintf(out, out_len, "timer #%u set for %d:%02d:%02d%s%s", (unsigned)id, seconds / 3600,
             (seconds / 60) % 60, seconds % 60, label ? " — " : "", label ? label : "");
    return true;
}

static bool tool_set_alarm(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len)
{
    const int hour = arg_int(args, "hour", -1);
    const int minute = arg_int(args, "minute", 0);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        snprintf(err, err_len, "give hour 0-23 (24 hour, whatever the display shows) and minute 0-59, "
                              "in the device's own timezone (%s)", aiclock_tz());
        return false;
    }
    if (!aiclock_ready()) {
        snprintf(err, err_len, "the clock is not set yet, so nothing can be scheduled");
        return false;
    }
    const char *label = arg_str(args, "label");
    const uint32_t id = sched_add_alarm(hour, minute, parse_days(arg_str(args, "repeat")), label,
                                        arg_str(args, "prompt"));
    if (!id) {
        snprintf(err, err_len, "no room; cancel something first");
        return false;
    }
    char when[48];
    sched_describe(sched_find(id), when, sizeof(when));
    snprintf(out, out_len, "alarm #%u set for %s%s%s", (unsigned)id, when, label ? " — " : "", label ? label : "");
    return true;
}

static bool tool_list_schedule(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len)
{
    (void)args;
    (void)err;
    (void)err_len;

    char now[32];
    aiclock_time_ampm(now, sizeof(now), false);
    size_t n = (size_t)snprintf(out, out_len, "it is %s (%s)\n", now, aiclock_tz());
    if (sched_count() == 0) {
        snprintf(out + n, out_len - n, "nothing scheduled");
        return true;
    }
    for (int i = 0; i < sched_count() && n < out_len; i++) {
        const sched_entry_t *e = sched_at(i);
        char when[48];
        sched_describe(e, when, sizeof(when));
        n += (size_t)snprintf(out + n, out_len - n, "#%u %s %s — %s%s%s\n", (unsigned)e->id,
                              e->kind == SCHED_TIMER ? "timer" : "alarm", when, e->label,
                              e->enabled ? "" : " (off)", e->prompt[0] ? " [asks you something]" : "");
    }
    return true;
}

static bool tool_cancel_schedule(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len)
{
    const int id = arg_int(args, "id", 0);
    if (id <= 0) {
        snprintf(err, err_len, "give the id from list_schedule");
        return false;
    }
    if (!sched_cancel((uint32_t)id)) {
        snprintf(err, err_len, "nothing is scheduled with id %d", id);
        return false;
    }
    snprintf(out, out_len, "cancelled #%d", id);
    return true;
}

const aiterm_tool_t TIME_TOOLS[] = {
    {
        .name = "set_timer",
        .description = "Start a countdown on the terminal. It rings when it finishes. Give any combination of "
                       "hours, minutes and seconds. A `prompt` makes it ask you that question instead of ringing, "
                       "which is how you schedule something to be looked up later.",
        .parameters = "{\"type\":\"object\",\"properties\":{"
                      "\"hours\":{\"type\":\"integer\",\"minimum\":0},"
                      "\"minutes\":{\"type\":\"integer\",\"minimum\":0},"
                      "\"seconds\":{\"type\":\"integer\",\"minimum\":0},"
                      "\"label\":{\"type\":\"string\",\"description\":\"what it is for, shown when it goes off\"},"
                      "\"prompt\":{\"type\":\"string\",\"description\":\"ask this instead of ringing\"}},"
                      "\"required\":[],\"additionalProperties\":false}",
        .risk = "modify",
        .run = tool_set_timer,
    },
    {
        .name = "set_alarm",
        .description = "Set an alarm at a time of day, in the terminal's own timezone. `repeat` may be daily, "
                       "weekdays, weekends, or a list of days like \"mon,wed,fri\"; leave it out for a one-off. "
                       "A `prompt` makes it ask you that question instead of ringing.",
        .parameters = "{\"type\":\"object\",\"properties\":{"
                      "\"hour\":{\"type\":\"integer\",\"minimum\":0,\"maximum\":23},"
                      "\"minute\":{\"type\":\"integer\",\"minimum\":0,\"maximum\":59},"
                      "\"repeat\":{\"type\":\"string\"},"
                      "\"label\":{\"type\":\"string\"},"
                      "\"prompt\":{\"type\":\"string\"}},"
                      "\"required\":[\"hour\"],\"additionalProperties\":false}",
        .risk = "modify",
        .run = tool_set_alarm,
    },
    {
        .name = "list_schedule",
        .description = "The current time on the terminal, and every timer and alarm it has set.",
        .parameters = "{\"type\":\"object\",\"properties\":{},\"additionalProperties\":false}",
        .risk = "info",
        .run = tool_list_schedule,
    },
    {
        .name = "cancel_schedule",
        .description = "Cancel a timer or alarm by the id list_schedule gives.",
        .parameters = "{\"type\":\"object\",\"properties\":{"
                      "\"id\":{\"type\":\"integer\",\"minimum\":1}},"
                      "\"required\":[\"id\"],\"additionalProperties\":false}",
        .risk = "modify",
        .run = tool_cancel_schedule,
    },
};

const size_t TIME_TOOL_COUNT = sizeof(TIME_TOOLS) / sizeof(TIME_TOOLS[0]);
