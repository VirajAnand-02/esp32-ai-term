#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Playing a stored voice note back on the terminal's own speaker.
//
// The note lives on the server — the device has nowhere to keep one — so this asks
// for it and plays what arrives, granting credit as the ring drains so the server
// cannot outrun the speaker. The same shape as the video player's audio half,
// without the picture.

#define NOTES_MAX 12
#define NOTE_ID_LEN 40

typedef struct {
    char id[NOTE_ID_LEN];
    float seconds;
    char at[24]; // when it was recorded, as the server formatted it
} note_entry_t;

void notes_init(void);

// Asks the server for the list. It arrives asynchronously; notes_count() grows.
void notes_refresh(void);
int notes_count(void);
const note_entry_t *notes_at(int index);
bool notes_listed(void); // a list has come back at least once

// Playback. `from_ms` starts part way in, which is how seeking works: the server
// restarts the stream somewhere else rather than the device buffering the whole clip.
void notes_play(const char *id, int from_ms);
void notes_stop(void);
void notes_pause(bool paused);

bool notes_playing(void);
bool notes_paused(void);
const char *notes_current(void);  // the id being played, or ""
int notes_position_ms(void);      // how far in, by what the speaker has actually played
int notes_length_ms(void);

// ── fed by the protocol layer ─────────────────────────────────────────────

void notes_on_list(const char *id, float seconds, const char *at, bool last);
void notes_on_start(const char *id, int rate, float seconds, int from_ms);
void notes_on_audio(const uint8_t *pcm, size_t bytes, uint32_t pts_ms);
void notes_on_seek(int from_ms);
void notes_on_end(const char *reason);

#ifdef __cplusplus
}
#endif
