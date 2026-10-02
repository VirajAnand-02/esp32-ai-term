#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "bsp.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "settings.h"
#include "sounds.h"

// What the terminal can say without words: a handful of named sounds, and a tiny
// note language so the agent can play something of its own.

typedef struct {
    int hz;  // 0 is a rest
    int ms;
} note_t;

typedef struct {
    const char *name;
    const char *description;
    const note_t *notes;
    size_t count;
} sound_t;

#define SOUND(id, desc, ...)                                                     \
    static const note_t id##_notes[] = {__VA_ARGS__};                            \
    static const sound_t id##_sound = {#id, desc, id##_notes,                    \
                                       sizeof(id##_notes) / sizeof(note_t)}

// Frequencies are round numbers rather than exact pitches; on a small speaker the
// shape of a sound matters far more than its tuning.
SOUND(beep, "a single short blip, for acknowledging something", {880, 90});
SOUND(ok, "two rising notes: done, and it worked", {784, 90}, {1175, 140});
SOUND(error, "two falling notes, low and blunt", {392, 130}, {262, 220});
SOUND(alert, "three urgent repeats", {1047, 80}, {0, 60}, {1047, 80}, {0, 60}, {1047, 80});
SOUND(chime, "a soft four-note arpeggio, for a gentle notification", {523, 120}, {659, 120}, {784, 120}, {1047, 260});
SOUND(tick, "a very short click, for counting or feedback", {1568, 25});
SOUND(boot, "the startup flourish", {392, 90}, {523, 90}, {659, 90}, {784, 200});
SOUND(listening, "a rising pair that says the microphone is open", {659, 70}, {988, 110});
SOUND(done, "a settled two-note fall, for finishing a job", {1047, 100}, {784, 180});
SOUND(alarm, "an insistent up-down siren", {880, 180}, {622, 180}, {880, 180}, {622, 180}, {880, 300});

static const sound_t *const SOUNDS[] = {
    &beep_sound, &ok_sound,        &error_sound, &alert_sound, &chime_sound,
    &tick_sound, &listening_sound, &done_sound,  &boot_sound,  &alarm_sound,
};
#define SOUND_COUNT (sizeof(SOUNDS) / sizeof(SOUNDS[0]))
_Static_assert(SOUND_COUNT == SOUNDS_COUNT, "a sound was added or removed: update the play_sound enum in tools.c");

// One sound at a time. The amp's enable pin is held across a whole sequence so it
// does not click between notes, which means a second caller arriving mid-sequence
// would switch the amp off underneath the first — i2s_channel_write then fails with
// "the channel is not enabled". That became reachable the moment an alarm started
// ringing from its own task while the buttons could still chirp.
static SemaphoreHandle_t s_lock;

void sounds_init(void)
{
    if (!s_lock) s_lock = xSemaphoreCreateMutex();
}

static bool play_notes(const note_t *notes, size_t count, int volume)
{
    if (!bsp_speaker_available()) return false;
    // A video stream owns the speaker and the shared scratch buffer while it runs;
    // a chirp on top would corrupt both.
    if (bsp_speaker_stream_active()) return false;

    // Waiting rather than dropping: a queued chirp a moment late is better than a
    // missing one, and the longest sequence here is under two seconds.
    if (s_lock && xSemaphoreTake(s_lock, pdMS_TO_TICKS(3000)) != pdTRUE) return false;

    bsp_speaker_enable(true);
    for (size_t i = 0; i < count; i++) {
        if (notes[i].hz > 0) bsp_speaker_tone(notes[i].hz, notes[i].ms, volume);
        else bsp_speaker_silence(notes[i].ms);
    }
    bsp_speaker_silence(25);
    bsp_speaker_enable(false);
    if (s_lock) xSemaphoreGive(s_lock);
    return true;
}

bool sounds_play(const char *name, int volume)
{
    for (size_t i = 0; i < SOUND_COUNT; i++) {
        if (strcasecmp(name, SOUNDS[i]->name) == 0) {
            return play_notes(SOUNDS[i]->notes, SOUNDS[i]->count, volume);
        }
    }
    return false;
}

void sounds_list(char *out, size_t len)
{
    size_t n = 0;
    for (size_t i = 0; i < SOUND_COUNT && n < len; i++) {
        n += snprintf(out + n, len - n, "%s%s", i ? ", " : "", SOUNDS[i]->name);
    }
}

// ── the note language ─────────────────────────────────────────────────────
// "C4:200 E4 G4:400 -:150" — a name, an optional # or b, an octave, and a length
// in milliseconds that carries over from the previous note if left out.

static const int SEMITONE[7] = {9, 11, 0, 2, 4, 5, 7}; // A B C D E F G

static int note_hz(const char *text, size_t len)
{
    if (len == 0 || text[0] == '-' || text[0] == 'r' || text[0] == 'R') return 0; // rest
    const char c = (char)toupper((unsigned char)text[0]);
    if (c < 'A' || c > 'G') return -1;

    size_t i = 1;
    int semitone = SEMITONE[c - 'A'];
    if (i < len && (text[i] == '#' || text[i] == 's')) {
        semitone++;
        i++;
    } else if (i < len && text[i] == 'b') {
        semitone--;
        i++;
    }

    int octave = 4;
    if (i < len && isdigit((unsigned char)text[i])) octave = text[i++] - '0';
    if (i != len) return -1;
    if (octave < 1 || octave > 8) return -1;

    // Scientific pitch notation: octaves start at C, so C4 is MIDI 60 and A4 is 69.
    const int midi = (octave + 1) * 12 + semitone;
    return (int)lroundf(440.0f * powf(2.0f, (float)(midi - 69) / 12.0f));
}

int sounds_melody(const char *score, int volume, char *err, size_t err_len)
{
    if (!bsp_speaker_available()) {
        snprintf(err, err_len, "no speaker is fitted on this device");
        return -1;
    }

    note_t notes[48];
    size_t count = 0;
    int last_ms = 200;
    int total_ms = 0;
    const char *p = score;

    while (*p && count < sizeof(notes) / sizeof(notes[0])) {
        while (*p == ' ' || *p == ',') p++;
        if (!*p) break;

        const char *start = p;
        while (*p && *p != ' ' && *p != ',' && *p != ':') p++;
        const size_t name_len = (size_t)(p - start);

        int ms = last_ms;
        if (*p == ':') {
            p++;
            int v = 0;
            while (*p >= '0' && *p <= '9') v = v * 10 + (*p++ - '0');
            if (v > 0) ms = v;
        }
        ms = ms < 20 ? 20 : (ms > 2000 ? 2000 : ms);

        const int hz = note_hz(start, name_len);
        if (hz < 0) {
            snprintf(err, err_len, "\"%.*s\" is not a note; use C4, F#3, Bb5 or - for a rest",
                     (int)name_len, start);
            return -1;
        }
        notes[count].hz = hz;
        notes[count].ms = ms;
        count++;
        last_ms = ms;
        total_ms += ms;

        if (total_ms > 20000) {
            snprintf(err, err_len, "that melody is longer than 20 seconds");
            return -1;
        }
    }

    if (count == 0) {
        snprintf(err, err_len, "give some notes, like \"C4:200 E4 G4:400\"");
        return -1;
    }
    play_notes(notes, count, volume);
    return total_ms;
}

bool sounds_cue(const char *name)
{
    if (!settings_get(SET_UI_SOUNDS)) return false;
    return sounds_play(name, -1);
}

const char *sounds_name(int index)
{
    return index >= 0 && index < (int)SOUND_COUNT ? SOUNDS[index]->name : NULL;
}
