#pragma once

#include "esp_err.h"

// Advertises <hostname>.local on every active interface. Call after
// net_wifi_start(); it follows the link up and down on its own.
esp_err_t net_mdns_start(const char *hostname, const char *instance_name);
