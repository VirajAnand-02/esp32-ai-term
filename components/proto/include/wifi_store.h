#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

// The networks this terminal knows.
//
// Kept here rather than in the settings component because settings are integers —
// one nvs_set_i32 per row — and these are strings. Stored as a single versioned
// blob, the same shape the schedule uses, so adding a field later does not brick
// the saved list: a blob whose version does not match is simply ignored.
//
// Six is more than enough for a device that lives in one or two places and gets
// taken somewhere occasionally, and the whole list is small enough to read in one
// go and hold in RAM.

#define WIFI_STORE_MAX  6
#define WIFI_SSID_LEN   33 // 32 plus the terminator, as the driver has it
#define WIFI_PASS_LEN   65 // 64 plus the terminator

typedef struct {
    char ssid[WIFI_SSID_LEN];
    char password[WIFI_PASS_LEN];
} wifi_saved_t;

esp_err_t wifi_store_init(void); // after nvs_flash_init

int wifi_store_count(void);

// NULL when out of range. Includes the password, so this is for the connecting code
// and the on-device editor — never for anything that leaves the box.
const wifi_saved_t *wifi_store_at(int index);

// Adds one, or replaces the password of an SSID already saved. The most recently
// added sits at the end; order is not a priority, since which one is joined is
// decided by what is actually in range.
esp_err_t wifi_store_add(const char *ssid, const char *password);

bool wifi_store_forget(const char *ssid);
int wifi_store_index_of(const char *ssid); // -1 if not saved

void wifi_store_clear(void);

#ifdef __cplusplus
}
#endif
