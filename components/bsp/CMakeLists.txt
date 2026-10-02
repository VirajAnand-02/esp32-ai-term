idf_component_register(SRCS "bsp.c" "mic.c" "speaker.c" "button.c" "keys.c" "display.cpp" "bench.cpp"
                       INCLUDE_DIRS "include"
                       PRIV_REQUIRES esp_psram spi_flash esp_driver_i2s esp_driver_ledc esp_driver_gpio esp_timer esp_pm lovyangfx)
