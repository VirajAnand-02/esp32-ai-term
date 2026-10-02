idf_component_register(SRCS "settings.c"
                       INCLUDE_DIRS "include"
                       REQUIRES bsp ui espressif__cjson
                       PRIV_REQUIRES nvs_flash esp_timer)
