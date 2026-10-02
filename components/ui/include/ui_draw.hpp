#pragma once

// The drawing vocabulary every screen shares: the palette, the fonts and the few
// helpers that any list or label needs. C++ only — it hands out the LovyanGFX
// canvas — so it lives beside ui.h rather than inside it.
//
// This exists because the games component copied all of it verbatim out of ui.cpp
// and the two then had to be kept in step by hand. One copy, in the component that
// owns the panel.

#include <LovyanGFX.hpp>

namespace uidraw {

// The dashboard's palette, so the device and the web look like one product.
constexpr uint32_t BG = 0x0B0906;
constexpr uint32_t BG_LINE = 0x140F09; // the darker scanline rows
constexpr uint32_t AMBER = 0xF3C56B;
constexpr uint32_t AMBER_DIM = 0x9A7A44;
constexpr uint32_t AMBER_FAINT = 0x5C4826;
constexpr uint32_t PHOS = 0x39FF7A;
constexpr uint32_t PHOS_DIM = 0x1E8F44;
constexpr uint32_t ERR = 0xFF4D3D;
constexpr uint32_t INFO = 0x7AD7FF;
constexpr uint32_t FG = 0xD8CCB4;

// The back buffer. Set once by ui_start; only the render task draws into it, which
// is what makes fit()'s shared buffer below safe.
extern LGFX_Sprite *cv;

int64_t now_ms();

uint32_t dim(uint32_t rgb, float f); // scales towards black; f is clamped to 0..1
void background();                   // near-black plus the scanlines

void small(); // FreeMono9pt7b, ~11 px a character
void large(); // FreeMonoBold12pt7b

// Shortens text with an ellipsis until it fits. Anything on a 240 px panel needs
// this: a line is only about twenty characters. Returns a pointer into a shared
// static buffer, so use the result before calling it again.
const char *fit(const char *text, int max_w);

void text_at(const char *s, int x, int y, uint32_t colour);       // left, auto-fitted
void text_centered(const char *s, int y, uint32_t colour);        // centred, auto-fitted
void text_right(const char *s, int x, int y, uint32_t colour);    // right-aligned to x

// Several lines of it, broken on word boundaries at the current font. When there is
// more than fits between `y` and `bottom` the tail is kept, because the newest words
// are the ones worth reading and there is no way to scroll back. `reveal` caps how
// many characters are drawn, which is what makes the typewriter effect; -1 for all
// of it. Returns the y it stopped at.
int text_block(const char *text, int x, int y, int max_w, int bottom, uint32_t colour, int line_h, int reveal = -1);

// The blinking block that says the machine is waiting for something — the end of a
// streaming reply, or where the next character will land while typing.
bool cursor_on(int64_t t);
void block_cursor(int x, int y, int w, int h, uint32_t colour, int64_t t);

// One row of a list: the highlight box, the label, and an optional value on the
// right. The geometry is shared so the launcher and the settings list line up.
void list_row(int y, const char *label, const char *value, bool selected);

} // namespace uidraw
