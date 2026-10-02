idf_component_register(SRCS "net_wifi.c" "net_mdns.c" "aiterm_ws.c" "wifi_store.c"
                       INCLUDE_DIRS "include"
                       REQUIRES freertos espressif__cjson
                       PRIV_REQUIRES esp_wifi esp_netif esp_event esp_timer esp-tls nvs_flash)
