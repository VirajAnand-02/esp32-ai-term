#pragma once

#include <stddef.h>
#include "aiterm_ws.h"

// The todo list's agent tools: add_todo, list_todos, check_todo, delete_todo.
// Without them "add a todo" had nowhere to go, and the agent set an alarm instead.
extern const aiterm_tool_t TODO_TOOLS[];
extern const size_t TODO_TOOL_COUNT;
