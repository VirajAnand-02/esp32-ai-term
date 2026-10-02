#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "wifi_store.h"

static const char *TAG = "wifi_store";

#define NAMESPACE    "wifi_nets"
#define BLOB_KEY     "nets"
#define BLOB_VERSION 1

static struct {
    uint32_t version;
    int count;
    wifi_saved_t items[WIFI_STORE_MAX];
} s;

static SemaphoreHandle_t s_lock;

static void lock(void)
{
    if (s_lock) xSemaphoreTake(s_lock, portMAX_DELAY);
}

static void unlock(void)
{
    if (s_lock) xSemaphoreGive(s_lock);
}

// Callers hold the lock.
static esp_err_t save_locked(void)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_blob(h, BLOB_KEY, &s, sizeof(s));
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

esp_err_t wifi_store_init(void)
{
    s_lock = xSemaphoreCreateMutex();
    if (!s_lock) return ESP_ERR_NO_MEM;

    nvs_handle_t h;
    bool loaded = false;
    if (nvs_open(NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        size_t len = sizeof(s);
        if (nvs_get_blob(h, BLOB_KEY, &s, &len) == ESP_OK && len == sizeof(s) && s.version == BLOB_VERSION) {
            loaded = true;
        }
        nvs_close(h);
    }
    if (!loaded) {
        memset(&s, 0, sizeof(s));
        s.version = BLOB_VERSION;
    }
    if (s.count < 0 || s.count > WIFI_STORE_MAX) s.count = 0;
    ESP_LOGI(TAG, "%d saved network%s", s.count, s.count == 1 ? "" : "s");
    return ESP_OK;
}

int wifi_store_count(void)
{
    return s.count;
}

const wifi_saved_t *wifi_store_at(int index)
{
    return index >= 0 && index < s.count ? &s.items[index] : NULL;
}

int wifi_store_index_of(const char *ssid)
{
    if (!ssid) return -1;
    for (int i = 0; i < s.count; i++) {
        if (strcmp(s.items[i].ssid, ssid) == 0) return i;
    }
    return -1;
}

esp_err_t wifi_store_add(const char *ssid, const char *password)
{
    if (!ssid || !*ssid) return ESP_ERR_INVALID_ARG;
    lock();
    int at = wifi_store_index_of(ssid);
    if (at < 0) {
        if (s.count >= WIFI_STORE_MAX) {
            unlock();
            ESP_LOGW(TAG, "no room for \"%s\"; forget one first", ssid);
            return ESP_ERR_NO_MEM;
        }
        at = s.count++;
    }
    // An existing SSID has its password replaced rather than being duplicated:
    // retyping it is what someone does when the network's password has changed.
    strlcpy(s.items[at].ssid, ssid, sizeof(s.items[at].ssid));
    strlcpy(s.items[at].password, password ? password : "", sizeof(s.items[at].password));
    const esp_err_t err = save_locked();
    unlock();
    ESP_LOGI(TAG, "saved \"%s\"%s", ssid, err == ESP_OK ? "" : " (but the write failed)");
    return err;
}

bool wifi_store_forget(const char *ssid)
{
    lock();
    const int at = wifi_store_index_of(ssid);
    if (at < 0) {
        unlock();
        return false;
    }
    // Closes the gap, so the list stays dense and wifi_store_at stays simple.
    for (int i = at; i < s.count - 1; i++) s.items[i] = s.items[i + 1];
    s.count--;
    memset(&s.items[s.count], 0, sizeof(s.items[s.count]));
    save_locked();
    unlock();
    ESP_LOGI(TAG, "forgot \"%s\"", ssid);
    return true;
}

void wifi_store_clear(void)
{
    lock();
    s.count = 0;
    memset(s.items, 0, sizeof(s.items));
    save_locked();
    unlock();
}
