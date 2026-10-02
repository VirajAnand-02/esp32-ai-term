#include "text_entry.hpp"

#include <string.h>

#include "shell_internal.hpp"

namespace shell {
namespace {

// Four rows of ten, the same in every set, so the muscle memory of where a letter
// sits survives switching case. A fifth row holds the actions, walked with the same
// keys as everything else rather than being bound to a key that navigation needs.
constexpr int COLS = 10;
constexpr int ROWS = 4;
constexpr int CELLS = COLS * ROWS;

const char *SETS[] = {
    "abcdefghijklmnopqrstuvwxyz0123456789",
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~ ",
};
constexpr int SET_COUNT = (int)(sizeof(SETS) / sizeof(SETS[0]));

enum action_t { ACT_SHIFT, ACT_SYMBOLS, ACT_SPACE, ACT_DEL, ACT_DONE, ACT_COUNT };
const char *ACTION_LABEL[ACT_COUNT] = {"aA", "#+=", "space", "del", "ok"};

constexpr int FIELD_Y = 30;
constexpr int GRID_Y = 76;
constexpr int CELL_W = 24;
constexpr int CELL_H = 24;
constexpr int ACTION_Y = 176;
constexpr int ACTION_H = 28;

// One editor at a time, which is all a single screen stack can show anyway.
char buf[128];
size_t cap;
char label_text[24];
int set_at;
int row; // 0..ROWS-1 in the grid, ROWS on the action row
int col;
text_entry_done_t on_done;
void *done_ctx;

char glyph(int index)
{
    const char *set = SETS[set_at];
    const int len = (int)strlen(set);
    return index < len ? set[index] : ' ';
}

void insert(char c)
{
    const size_t n = strlen(buf);
    if (n + 1 >= cap || n + 1 >= sizeof(buf)) return;
    buf[n] = c;
    buf[n + 1] = '\0';
}

void backspace()
{
    const size_t n = strlen(buf);
    if (n) buf[n - 1] = '\0';
}

// Closes first, then reports, so the callback may push a screen of its own without
// this one landing back on top of it.
void finish(bool ok)
{
    const text_entry_done_t cb = on_done;
    void *ctx = done_ctx;
    on_done = nullptr;
    ui_pop();
    if (cb) cb(ok ? buf : nullptr, ctx);
}

void enter(void *)
{
    // Deliberately not reset here: text_entry_open has already filled these in, and
    // enter() runs afterwards on the render task.
}

void input(void *, const ui_input_t *in)
{
    const int64_t t = now_ms();

    if (in->pressed[BSP_KEY_BACK]) {
        finish(false);
        return;
    }

    if (repeating(BSP_KEY_LEFT, in, t)) col--;
    if (repeating(BSP_KEY_RIGHT, in, t)) col++;
    if (in->pressed[BSP_KEY_UP]) row--;
    if (in->pressed[BSP_KEY_DOWN]) row++;

    // The action row has five cells, the grid has ten, so the column has to be
    // clamped on the way in and out rather than just wrapped.
    if (row < 0) row = ROWS;
    if (row > ROWS) row = 0;
    const int width = row == ROWS ? ACT_COUNT : COLS;
    if (col < 0) col = width - 1;
    if (col >= width) col = 0;

    if (!in->pressed[BSP_KEY_OK]) return;

    if (row < ROWS) {
        insert(glyph(row * COLS + col));
        return;
    }
    switch ((action_t)col) {
    case ACT_SHIFT:
        // Between the two letter sets. From the symbols set it comes back to lower
        // case, which is what pressing "aA" there obviously means.
        set_at = set_at == 0 ? 1 : 0;
        break;
    case ACT_SYMBOLS:
        set_at = set_at == 2 ? 0 : 2;
        break;
    case ACT_SPACE:
        insert(' ');
        break;
    case ACT_DEL:
        backspace();
        break;
    case ACT_DONE:
        finish(true);
        break;
    default:
        break;
    }
}

void paint(void *, void *, int64_t t)
{
    small();
    text_at(label_text, 10, 8, AMBER_DIM);

    // The tail of what has been typed, because the tail is where the cursor is, with
    // the cursor sitting right after it. Shown in clear even for a password:
    // correcting a character you cannot see, one d-pad press at a time, is worse than
    // someone reading over your shoulder.
    const int field_w = cv->width() - 30;
    const char *shown = buf;
    while (*shown && cv->textWidth(shown) > field_w) shown++;
    cv->setTextColor(FG);
    cv->drawString(shown, 10, FIELD_Y);
    block_cursor(10 + cv->textWidth(shown), FIELD_Y + 1, 8, 14, AMBER, t);
    cv->drawFastHLine(10, GRID_Y - 10, cv->width() - 20, dim(AMBER, 0.18f));

    for (int r = 0; r < ROWS; r++) {
        for (int c = 0; c < COLS; c++) {
            const bool on = row == r && col == c;
            const int x = c * CELL_W;
            const int y = GRID_Y + r * CELL_H;
            if (on) cv->fillRoundRect(x + 1, y, CELL_W - 2, CELL_H - 2, 3, dim(AMBER, 0.22f));
            const char ch[2] = {glyph(r * COLS + c), '\0'};
            cv->setTextColor(on ? PHOS : FG);
            cv->drawString(ch, x + (CELL_W - cv->textWidth(ch)) / 2, y + 4);
        }
    }

    const int aw = cv->width() / ACT_COUNT;
    for (int a = 0; a < ACT_COUNT; a++) {
        const bool on = row == ROWS && col == a;
        const int x = a * aw;
        if (on) cv->fillRoundRect(x + 2, ACTION_Y, aw - 4, ACTION_H - 4, 4, dim(AMBER, 0.22f));
        else cv->drawRoundRect(x + 2, ACTION_Y, aw - 4, ACTION_H - 4, 4, dim(AMBER, 0.2f));
        const char *lbl = ACTION_LABEL[a];
        cv->setTextColor(on ? PHOS : AMBER_DIM);
        cv->drawString(lbl, x + (aw - cv->textWidth(lbl)) / 2, ACTION_Y + 6);
    }

    hint("ok picks  ·  back cancels");
}

const ui_app_t entry_app = {"typing", enter, input, paint, nullptr, nullptr};

} // namespace

void text_entry_open(const char *label, const char *initial, size_t max_len, text_entry_done_t done, void *ctx)
{
    strlcpy(label_text, label ? label : "text", sizeof(label_text));
    strlcpy(buf, initial ? initial : "", sizeof(buf));
    cap = max_len && max_len < sizeof(buf) ? max_len : sizeof(buf);
    set_at = 0;
    row = 0;
    col = 0;
    on_done = done;
    done_ctx = ctx;
    ui_push(&entry_app);
}

} // namespace shell
