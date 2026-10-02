idf_component_register(SRCS "ui.cpp" "ui_draw.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES bsp
                       PRIV_REQUIRES lovyangfx esp_timer)
