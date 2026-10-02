#include "esp_check.h"
#include "esp_log.h"
#include "mdns.h"

#include "net_mdns.h"

static const char *TAG = "mdns";

esp_err_t net_mdns_start(const char *hostname, const char *instance_name)
{
    ESP_RETURN_ON_ERROR(mdns_init(), TAG, "init");
    ESP_RETURN_ON_ERROR(mdns_hostname_set(hostname), TAG, "hostname");
    ESP_RETURN_ON_ERROR(mdns_instance_name_set(instance_name), TAG, "instance name");

    ESP_LOGI(TAG, "advertising %s.local", hostname);
    return ESP_OK;
}
