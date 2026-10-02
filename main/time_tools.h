#pragma once

#include <stddef.h>
#include "aiterm_ws.h"

// The clock's agent tools: set_timer, set_alarm, list_schedule, cancel_schedule.
// A separate table from DEVICE_TOOLS so the timekeeping stays in one file;
// app_main hands both to the hello frame as one list.
extern const aiterm_tool_t TIME_TOOLS[];
extern const size_t TIME_TOOL_COUNT;
