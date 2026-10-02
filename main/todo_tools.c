#include <stdio.h>
#include <string.h>

#include "cJSON.h"

#include "shell.h"
#include "todo_tools.h"

// The agent's side of the todo list. Asked to "add a todo" with no tool for it,
// the agent improvised a one-shot alarm labelled "To-do: …": it showed on the
// dashboard as the next alarm and never appeared in the todos app.
//
// The ids are the console's flat index (every daily first, then the rest), so they
// shift when one is deleted. That is why each call answers with the fresh list.

static bool list_into(char *out, size_t out_len)
{
    const int total = shell_todo_total();
    size_t n = 0;
    out[0] = '\0';
    for (int i = 0; i < total && n < out_len; i++) {
        char row[64];
        shell_todo_describe(i, row, sizeof(row));
        n += (size_t)snprintf(out + n, out_len - n, "%d  %s\n", i, row);
    }
    if (!total) snprintf(out, out_len, "no todos");
    return true;
}

static bool tool_add_todo(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len)
{
    const cJSON *text = cJSON_GetObjectItemCaseSensitive(args, "text");
    if (!cJSON_IsString(text) || !text->valuestring[0]) {
        snprintf(err, err_len, "say what the todo is");
        return false;
    }
    const cJSON *daily = cJSON_GetObjectItemCaseSensitive(args, "daily");
    if (!shell_todo_add(text->valuestring, cJSON_IsTrue(daily))) {
        snprintf(err, err_len, "the list is full; delete something first");
        return false;
    }
    const size_t n = (size_t)snprintf(out, out_len, "added%s. the list is now:\n", cJSON_IsTrue(daily) ? ", daily" : "");
    return n < out_len ? list_into(out + n, out_len - n) : true;
}

static bool tool_list_todos(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len)
{
    (void)args;
    (void)err;
    (void)err_len;
    return list_into(out, out_len);
}

static bool by_index(const cJSON *args, bool (*op)(int), const char *done, char *out, size_t out_len, char *err,
                     size_t err_len)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(args, "index");
    if (!cJSON_IsNumber(v) || !op((int)v->valuedouble)) {
        snprintf(err, err_len, "no todo at that index; list_todos gives them");
        return false;
    }
    const size_t n = (size_t)snprintf(out, out_len, "%s. the list is now:\n", done);
    return n < out_len ? list_into(out + n, out_len - n) : true;
}

static bool tool_check_todo(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len)
{
    return by_index(args, shell_todo_toggle_at, "toggled", out, out_len, err, err_len);
}

static bool tool_delete_todo(const cJSON *args, char *out, size_t out_len, char *err, size_t err_len)
{
    return by_index(args, shell_todo_delete_at, "deleted", out, out_len, err, err_len);
}

#define INDEX_PARAMS                                                                                                  \
    "{\"type\":\"object\",\"properties\":{"                                                                           \
    "\"index\":{\"type\":\"integer\",\"minimum\":0,\"description\":\"the number list_todos shows\"}},"                \
    "\"required\":[\"index\"],\"additionalProperties\":false}"

const aiterm_tool_t TODO_TOOLS[] = {
    {
        .name = "add_todo",
        .description = "Add an item to the terminal's todo list, the one its todos app shows. Use this for anything "
                       "said as a todo, a task or something to remember to do — not an alarm. Set an alarm as well "
                       "only if they ask to be reminded at a time. `daily` makes it come back unticked every day. "
                       "The panel shows about 40 characters, so keep `text` short; leave out words like \"tomorrow\" "
                       "that will be stale.",
        .parameters = "{\"type\":\"object\",\"properties\":{"
                      "\"text\":{\"type\":\"string\",\"maxLength\":39},"
                      "\"daily\":{\"type\":\"boolean\"}},"
                      "\"required\":[\"text\"],\"additionalProperties\":false}",
        .risk = "modify",
        .run = tool_add_todo,
    },
    {
        .name = "list_todos",
        .description = "The terminal's todo list: index, [x] if ticked, and \"daily\" for the ones that repeat.",
        .parameters = "{\"type\":\"object\",\"properties\":{},\"additionalProperties\":false}",
        .risk = "info",
        .run = tool_list_todos,
    },
    {
        .name = "check_todo",
        .description = "Tick a todo, or untick it if it is already ticked. Indexes shift after a delete, so take "
                       "them from the latest list.",
        .parameters = INDEX_PARAMS,
        .risk = "modify",
        .run = tool_check_todo,
    },
    {
        .name = "delete_todo",
        .description = "Remove a todo. Indexes shift after a delete, so take them from the latest list.",
        .parameters = INDEX_PARAMS,
        .risk = "modify",
        .run = tool_delete_todo,
    },
};

const size_t TODO_TOOL_COUNT = sizeof(TODO_TOOLS) / sizeof(TODO_TOOLS[0]);
