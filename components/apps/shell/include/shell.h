#pragma once

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// The launcher and the apps behind it.
//
// Registers itself as the ui's home screen, so the back key opens it from the
// terminal and nothing else has to know it exists. The apps are drawn by the ui's
// own render task; none of this owns a task or the panel.

void shell_init(void);

// The ringing screen. Strings rather than the schedule record, so the shell does
// not have to know what a schedule is — it only has to show one going off.
void shell_alarm_show(const char *label, const char *detail);
bool shell_alarm_active(void); // false once any key has dismissed it
void shell_alarm_dismiss(void);

// The pomodoro, driven from somewhere that is not the panel — the console, and
// whatever else wants it later. Starting one from here is the same as pressing ok
// on its screen.
void shell_pomodoro_start(void);
void shell_pomodoro_skip(void);  // straight to the next stage
void shell_pomodoro_stop(void);
// "focus 2/4 12:30 left", or "not running".
void shell_pomodoro_status(char *out, size_t n);

// The todo list, over a flat index: every daily first, then the rest. Exposed so the
// serial console can drive a screen nobody in the loop can see.
int shell_todo_total(void);
void shell_todo_describe(int index, char *out, size_t n); // "[x] daily  water the plants"
bool shell_todo_add(const char *text, bool daily);
bool shell_todo_toggle_at(int index);
bool shell_todo_delete_at(int index);

#ifdef __cplusplus
}
#endif
