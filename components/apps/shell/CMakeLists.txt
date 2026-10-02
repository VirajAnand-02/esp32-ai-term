idf_component_register(SRCS "shell.cpp" "settings_app.cpp" "sounds_app.cpp" "diag_app.cpp" "alarm_app.cpp" "clock_app.cpp" "pomodoro.cpp" "dashboard.cpp" "notes_app.cpp" "notify_app.cpp" "wifi_app.cpp" "text_entry.cpp" "todo_app.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES ui bsp settings sounds clock notes notify proto
                       PRIV_REQUIRES lovyangfx nvs_flash esp_timer esp_wifi esp_netif esp_app_format)
