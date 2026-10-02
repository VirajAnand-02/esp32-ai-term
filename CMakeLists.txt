# The following five lines of boilerplate have to be in your project's
# CMakeLists in this exact order for cmake to work correctly
cmake_minimum_required(VERSION 3.22)

# components/ is only scanned one level deep, so the apps each need their own entry.
set(EXTRA_COMPONENT_DIRS "components/apps/video" "components/apps/shell" "components/apps/notes")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(esp32-ai-term)
