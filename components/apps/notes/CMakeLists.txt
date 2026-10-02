idf_component_register(SRCS "notes.c"
                       INCLUDE_DIRS "include"
                       REQUIRES bsp proto
                       PRIV_REQUIRES esp_timer esp_ringbuf)
