idf_component_register(SRCS "video_player.c"
                       INCLUDE_DIRS "include"
                       REQUIRES bsp ui proto
                       PRIV_REQUIRES esp_timer esp_ringbuf)
