#include "ui_draw.hpp"

#include <string.h>

#include "esp_timer.h"

namespace uidraw {

LGFX_Sprite *cv = nullptr;

int64_t now_ms()
{
    return esp_timer_get_time() / 1000;
}

uint32_t dim(uint32_t rgb, float f)
{
    if (f < 0) f = 0;
    if (f > 1) f = 1;
    const uint32_t r = (uint32_t)(((rgb >> 16) & 0xFF) * f);
    const uint32_t g = (uint32_t)(((rgb >> 8) & 0xFF) * f);
    const uint32_t b = (uint32_t)((rgb & 0xFF) * f);
    return (r << 16) | (g << 8) | b;
}

void background()
{
    cv->fillScreen(BG);
    // Scanlines belong to the background, not on top of the text, so glyphs stay
    // crisp while flat areas still read as a CRT.
    for (int y = 0; y < cv->height(); y += 3) cv->drawFastHLine(0, y, cv->width(), BG_LINE);
}

void small()
{
    cv->setFont(&fonts::FreeMono9pt7b);
}

void large()
{
    cv->setFont(&fonts::FreeMonoBold12pt7b);
}

const char *fit(const char *text, int max_w)
{
    static char buf[64];
    strlcpy(buf, text, sizeof(buf));
    if (cv->textWidth(buf) <= max_w) return buf;

    // Two dots rather than a single ellipsis glyph: FreeMono has no U+2026, and a
    // missing glyph on this panel draws as a blank box.
    for (size_t keep = strlen(buf); keep > 2; keep--) {
        buf[keep - 2] = '.';
        buf[keep - 1] = '.';
        buf[keep] = 0;
        if (cv->textWidth(buf) <= max_w) break;
    }
    return buf;
}

void text_at(const char *s, int x, int y, uint32_t colour)
{
    cv->setTextColor(colour);
    cv->drawString(fit(s, cv->width() - x - 6), x, y);
}

void text_centered(const char *s, int y, uint32_t colour)
{
    const char *t = fit(s, cv->width() - 16);
    cv->setTextColor(colour);
    cv->drawString(t, (cv->width() - cv->textWidth(t)) / 2, y);
}

void text_right(const char *s, int x, int y, uint32_t colour)
{
    cv->setTextColor(colour);
    cv->drawString(s, x - cv->textWidth(s), y);
}

void list_row(int y, const char *label, const char *value, bool selected)
{
    const int w = cv->width();
    if (selected) {
        cv->fillRoundRect(8, y - 5, w - 16, 26, 5, dim(AMBER, 0.13f));
        cv->drawRoundRect(8, y - 5, w - 16, 26, 5, AMBER_DIM);
    }
    // The value is drawn first and the label fitted around it, so a long label is
    // what gets an ellipsis rather than the number being pushed off the edge.
    int label_w = w - 40;
    if (value && *value) {
        text_right(value, w - 18, y, selected ? PHOS : FG);
        label_w = w - 40 - cv->textWidth(value);
    }
    cv->setTextColor(selected ? PHOS : AMBER_DIM);
    cv->drawString(fit(label, label_w), 18, y);
}

bool cursor_on(int64_t t)
{
    return (t % 1060) < 620;
}

void block_cursor(int x, int y, int w, int h, uint32_t colour, int64_t t)
{
    if (cursor_on(t)) cv->fillRect(x, y, w, h, colour);
}

// Breaks text on word boundaries at the current font. Returns the number of lines
// written into `out`, in order; the caller decides which of them to draw.
static int wrap(const char *text, int max_w, char out[][40], int max_lines)
{
    int lines = 0;
    const char *p = text;
    char line[40];

    while (*p && lines < max_lines) {
        while (*p == ' ') p++;
        if (!*p) break;

        size_t take = 0, brk = 0, n = 0;
        while (p[n] && p[n] != '\n' && n < sizeof(line) - 1) {
            line[n] = p[n];
            line[n + 1] = '\0';
            if (cv->textWidth(line) > max_w) break;
            n++;
            take = n;
            if (p[n - 1] == ' ') brk = n;
        }
        if (p[take] && p[take] != '\n' && p[take] != ' ' && brk > 0) take = brk;
        if (take == 0) take = 1; // a single glyph wider than the column

        memcpy(out[lines], p, take);
        out[lines][take] = '\0';
        lines++;
        p += take;
        if (*p == '\n') p++;
    }
    return lines;
}

int text_block(const char *text, int x, int y, int max_w, int bottom, uint32_t colour, int line_h, int reveal)
{
    if (!text) return y;
    char clipped[900];
    if (reveal >= 0) {
        int n = reveal;
        const int len = (int)strlen(text);
        if (n > len) n = len;
        if (n < 0) n = 0;
        if (n > (int)sizeof(clipped) - 1) n = (int)sizeof(clipped) - 1;
        memcpy(clipped, text, n);
        clipped[n] = '\0';
        text = clipped;
    }

    // Shared, like fit()'s buffer, and safe for the same reason: only the render
    // task ever draws.
    static char lines[40][40];
    const int room = (bottom - y) / line_h;
    const int count = wrap(text, max_w, lines, 40);
    const int first = count > room ? count - room : 0;

    cv->setTextColor(colour);
    for (int i = first; i < count; i++) {
        cv->drawString(lines[i], x, y);
        y += line_h;
    }
    return y;
}

} // namespace uidraw
