#pragma once

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// The terminal's non-verbal voice: named sounds, and a small note language.

// Adding a sound means adding it to the play_sound enum in tools.c as well; the
// static assertion in sounds.c fails if this count and the table disagree.
#define SOUNDS_COUNT 10

// Plays a named sound. `volume` is 0-100, or -1 for the speaker's current setting.
// Returns false if there is no such sound.
// Creates the lock that keeps two callers from fighting over the amplifier.
// Call once before anything can play.
void sounds_init(void);

bool sounds_play(const char *name, int volume);

// The same, for the interface's own cues (key clicks, the push-to-talk chirps).
// Silent when the ui_sounds setting is off; an explicit play_sound is not, because
// that one was asked for.
bool sounds_cue(const char *name);

// Comma-separated names, for tool schemas and error messages.
void sounds_list(char *out, size_t len);

// The bank one entry at a time, for a screen that lists them. NULL past the end.
const char *sounds_name(int index);

// Plays a score like "C4:200 E4 G4:400 -:150" — note, optional # or b, octave, and
// a length in milliseconds that carries over when left out; '-' is a rest.
// Returns the length played in milliseconds, or -1 with `err` filled in.
int sounds_melody(const char *score, int volume, char *err, size_t err_len);

#ifdef __cplusplus
}
#endif
