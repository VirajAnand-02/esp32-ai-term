#include "shell_internal.hpp"

#include <string.h>

#include "shell.h"

// The screen an alarm puts up when it goes off. Deliberately loud and deliberately
// modal: it takes the panel, says what it is, and any key dismisses it — including
// back, which everywhere else means "go up a level" but here means "stop".

namespace shell {
namespace {

char label[40];
char detail[40];
volatile bool ringing;

void enter(void *)
{
    // Any key held as the alarm appears would dismiss it on the first frame.
    bsp_keys_flush();
}

void input(void *, const ui_input_t *in)
{
    for (int k = 0; k < BSP_KEY_COUNT; k++) {
        if (!in->pressed[k]) continue;
        ringing = false;
        ui_pop();
        return;
    }
}

void paint(void *, void *, int64_t t)
{
    // A slow pulse behind it, so it reads as ringing rather than as a message that
    // happens to be on screen.
    const float beat = 0.18f + 0.18f * sinf(t / 180.0f);
    cv->fillRect(0, 0, cv->width(), cv->height(), dim(ERR, beat));

    large();
    text_centered(label[0] ? label : "ALARM", 74, FG);
    small();
    if (detail[0]) text_centered(detail, 112, AMBER);
    if ((t / 400) % 2 == 0) text_centered("any key to stop", 168, PHOS);
}

const ui_app_t app = {"alarm", enter, input, paint, nullptr, nullptr};

} // namespace
} // namespace shell

extern "C" {

void shell_alarm_show(const char *l, const char *d)
{
    strlcpy(shell::label, l ? l : "", sizeof(shell::label));
    strlcpy(shell::detail, d ? d : "", sizeof(shell::detail));
    shell::ringing = true;
    ui_push(&shell::app);
}

bool shell_alarm_active(void)
{
    return shell::ringing;
}

void shell_alarm_dismiss(void)
{
    if (!shell::ringing) return;
    shell::ringing = false;
    ui_pop();
}

} // extern "C"
