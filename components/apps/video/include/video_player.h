#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Plays MJPEG with sound, streamed from the server. The server has already cropped
// and scaled every frame to this panel, so the device only decodes, presents and
// keeps time.
//
// Audio is the master clock: the I2S hardware paces itself, so a frame is shown when
// its timestamp catches up with the audio actually played, and dropped if it is late.

void video_player_start(const char *id, int w, int h, int fps, int audio_rate);
void video_player_frame(const uint8_t *jpeg, size_t len, uint32_t pts_ms);
void video_player_audio(const int16_t *pcm, size_t samples, uint32_t pts_ms);
void video_player_stop(const char *reason);

// Freezes playback where it is. The audio writer stops pulling from the ring, which
// is what actually stops the clock — the speaker's own sample counter is the master,
// so nothing else has to be told the time is not passing.
void video_player_pause(bool paused);
bool video_player_paused(void);

// Throws away everything buffered and re-aligns on the next frame. Used after a
// seek, where the frames already in hand belong to the old position and showing any
// of them would be a visible jump backwards.
void video_player_flush(void);

bool video_player_active(void);

#ifdef __cplusplus
}
#endif
