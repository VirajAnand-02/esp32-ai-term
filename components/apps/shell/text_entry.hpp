#pragma once

#include <stddef.h>

#include "ui.h"

// Typing, with five keys and a button.
//
// The firmware had no text entry of any kind before this — every screen was a list
// or a value to nudge — and a Wi-Fi password cannot be either of those. It is a
// grid of characters walked with the d-pad: tedious for a long password, and the
// only option on hardware with no keyboard.
//
// Written as its own pushed screen so it is reusable. Renaming a voice note or an
// alarm wants exactly this.

namespace shell {

// `done` is called with what was typed, or with NULL if back was pressed. It fires
// after the editor has closed itself, so the callback is free to push another screen.
typedef void (*text_entry_done_t)(const char *text, void *ctx);

void text_entry_open(const char *label, const char *initial, size_t max_len, text_entry_done_t done, void *ctx);

} // namespace shell
