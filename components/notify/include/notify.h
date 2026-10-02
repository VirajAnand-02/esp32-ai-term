#pragma once

#include <stdbool.h>
#include <time.h>

#ifdef __cplusplus
extern "C" {
#endif

// Things that happened while nobody was looking.
//
// Deliberately small and deliberately not persisted. A notification that survives a
// reboot has stopped being a notification and become a to-do list, which is a
// different feature with different rules; these are here to answer "what did I miss
// while the screen was dark", and the answer stops mattering once it has been read.
//
// The store also owns the status LED's side of it: post something and a dim amber
// stays lit while the panel sleeps, read them and it goes dark again. Keeping that
// here means no caller has to remember to keep the two in step.

#define NOTIFY_MAX   16
#define NOTIFY_TITLE 24
#define NOTIFY_BODY  96

typedef struct {
    time_t at; // 0 if the clock was not set yet
    char title[NOTIFY_TITLE];
    char body[NOTIFY_BODY];
    bool read;
} notify_entry_t;

void notify_init(void);

// Safe from any task. `body` may be NULL. The oldest is dropped once full, on the
// grounds that if sixteen have piled up the first one is no longer news.
void notify_post(const char *title, const char *body);

int notify_count(void);
int notify_unread(void);

// Newest first, so index 0 is what just happened. NULL when out of range. The
// pointer is into the store, so it is for reading now, not for keeping — the same
// contract as sched_at().
const notify_entry_t *notify_at(int index);

void notify_mark_all_read(void);
void notify_clear(void);

#ifdef __cplusplus
}
#endif
