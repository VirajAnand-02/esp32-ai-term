idf_component_register(SRCS "app_main.c" "tools.c" "time_tools.c" "todo_tools.c" "recorder.c"
                       INCLUDE_DIRS "."
                       PRIV_REQUIRES bsp ui proto video notes notify settings sounds shell clock nvs_flash esp_netif esp_event esp_wifi espressif__cjson esp_app_format esp_driver_usb_serial_jtag esp_timer esp_pm lwip
                       EMBED_FILES "bench_assets/flat.jpg" "bench_assets/photo.jpg" "bench_assets/noise.jpg" "bench_assets/photo_q12.jpg" "bench_assets/photo_q20.jpg")
