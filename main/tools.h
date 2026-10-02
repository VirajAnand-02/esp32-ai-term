#pragma once

#include <stddef.h>
#include <stdint.h>
#include "aiterm_ws.h"

// Tools this terminal offers the agent (on-board LED + status).
extern const aiterm_tool_t DEVICE_TOOLS[];
extern const size_t DEVICE_TOOL_COUNT;

// Returns the LED to the colour the agent last set (or the idle colour).
void tools_led_idle(void);

// Shows a transient status colour without changing the idle colour.
void tools_led_status(uint8_t r, uint8_t g, uint8_t b);

// Called by the display tools: keeps whatever they drew on screen instead of
// letting the app's own status screen paint over it.
void app_display_hold(void);
