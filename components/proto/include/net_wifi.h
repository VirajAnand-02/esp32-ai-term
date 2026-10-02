#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "freertos/FreeRTOS.h"
#include "esp_err.h"

#include "wifi_store.h"

#ifdef __cplusplus
extern "C" {
#endif

// Station mode over a list of saved networks.
//
// The rule, which is deliberate rather than incidental: once joined, it stays. It
// never re-scans and never moves to a saved network with a stronger signal, because
// roaming mid-conversation costs a websocket and buys nothing on a device that sits
// on a desk. A scan happens on exactly one occasion — the link actually dropped.

typedef enum {
    NET_WIFI_IDLE,         // nothing saved, so nothing to try
    NET_WIFI_SCANNING,     // looking for which of the saved ones is in range
    NET_WIFI_CONNECTING,
    NET_WIFI_CONNECTED,
    NET_WIFI_NO_NETWORK,   // scanned; none of the saved ones are here
    NET_WIFI_BAD_PASSWORD, // a saved network rejected the password we have
} net_wifi_state_t;

const char *net_wifi_state_name(net_wifi_state_t state);

// Called from the default event loop task; keep it short.
typedef void (*net_wifi_state_cb_t)(net_wifi_state_t state, void *ctx);

typedef struct {
    const char *hostname;    // DHCP hostname shown by the router, may be NULL
    net_wifi_state_cb_t cb;  // may be NULL
    void *cb_ctx;
} net_wifi_config_t;

// Brings up the radio and starts working through whatever wifi_store holds. An empty
// store is not an error: it comes up NET_WIFI_IDLE so the device is still usable and
// a network can be added from the panel.
//
// Requires NVS, wifi_store_init(), esp_netif_init() and the default event loop.
esp_err_t net_wifi_start(const net_wifi_config_t *cfg);

bool net_wifi_wait_connected(TickType_t timeout);
bool net_wifi_is_connected(void);

net_wifi_state_t net_wifi_state(void);
const char *net_wifi_ssid(void); // what is joined, or being tried; "" when idle

// Start again from the top of the saved list. For after a network has been added or
// forgotten, so the change takes effect without a reboot.
void net_wifi_retry_now(void);

// ── looking around, for the join screen ──────────────────────────────────

typedef struct {
    char ssid[WIFI_SSID_LEN];
    int8_t rssi;
    bool open;  // no password needed
    bool saved; // already in wifi_store
} net_wifi_ap_t;

// Asks for a list of what is nearby. Returns immediately; poll net_wifi_scan_busy()
// and then read the results. Refused while the reconnect logic is mid-scan.
esp_err_t net_wifi_scan_start(void);
bool net_wifi_scan_busy(void);

// Strongest first, duplicates removed. Returns how many were written.
int net_wifi_scan_results(net_wifi_ap_t *out, int max);

#ifdef __cplusplus
}
#endif
