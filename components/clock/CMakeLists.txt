idf_component_register(SRCS "aiclock.c" "schedule.c"
                       INCLUDE_DIRS "include"
                       PRIV_REQUIRES nvs_flash esp_timer esp_netif lwip)
