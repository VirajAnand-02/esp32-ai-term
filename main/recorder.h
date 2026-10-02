#pragma once

#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"

// Called when a recording finishes, from the recorder task.
typedef void (*recorder_done_t)(bool ok, const char *summary, void *ctx);

// Records from the mic and uploads it as `clip_id`. One at a time.
// `seconds <= 0` records until recorder_stop(), capped at `max_seconds` (0 for the
// default). `prompt` asks the server to transcribe the clip and answer it.
//
// The cap is explicit because the two open-ended users want very different ones: a
// spoken question is done in well under a minute, while cutting a voice note off at
// the same length would make the feature pointless. Nothing is buffered locally —
// the clip streams up as it is captured — so the cap exists only so a stuck button
// cannot record for ever.
esp_err_t recorder_start(const char *clip_id, int seconds, int max_seconds, const char *source, bool prompt,
                         recorder_done_t done, void *ctx);

// Ends an open-ended recording. `abort` throws the audio away instead of sending it.
void recorder_stop(bool abort);

#define RECORDER_MAX_SECONDS 30       // a spoken question
#define RECORDER_MAX_NOTE_SECONDS 600 // a voice note left running

bool recorder_active(void);

// A random hex id for clips the device starts itself.
void recorder_id(char *out, size_t len);
