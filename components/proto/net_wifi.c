#include <inttypes.h>
#include <string.h>
#include <sys/param.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"

#include "net_wifi.h"
#include "wifi_store.h"

#define CONNECTED_BIT BIT0
#define RETRY_MIN_MS  500
#define RETRY_MAX_MS  30000
// A dropped link is usually the access point blinking, not the network going away,
// and re-associating is far quicker than a scan. Only after this many consecutive
// failures on the same network is it worth looking elsewhere.
#define FAILS_BEFORE_NEXT 2
// What a scan can see at once. More than this in range is a crowded flat, and the
// saved ones are what matter anyway.
#define SCAN_SLOTS 24

static const char *TAG = "wifi";

static EventGroupHandle_t s_events;
static esp_timer_handle_t s_retry_timer;
static uint32_t s_retry_ms = RETRY_MIN_MS;
static net_wifi_state_cb_t s_cb;
static void *s_cb_ctx;
static net_wifi_state_t s_state = NET_WIFI_IDLE;

// The saved networks seen in the last scan, strongest first, and where we are in
// that list. Rebuilt on every scan; walked one at a time on failure.
static char s_order[WIFI_STORE_MAX][WIFI_SSID_LEN];
static int s_order_count;
static int s_order_at;
static int s_fails;
static char s_ssid[WIFI_SSID_LEN];

// Two reasons to scan and they must not be confused: the reconnect logic needs the
// result to pick a network, the join screen just wants a list to show.
static bool s_scan_for_reconnect;
static bool s_scan_for_ui;
static net_wifi_ap_t s_seen[SCAN_SLOTS];
static int s_seen_count;

static void try_current(void);
static void begin_reconnect_scan(void);

const char *net_wifi_state_name(net_wifi_state_t state)
{
    switch (state) {
    case NET_WIFI_IDLE:         return "no network set";
    case NET_WIFI_SCANNING:     return "scanning";
    case NET_WIFI_CONNECTING:   return "joining wifi";
    case NET_WIFI_CONNECTED:    return "connected";
    case NET_WIFI_NO_NETWORK:   return "no known wifi here";
    case NET_WIFI_BAD_PASSWORD: return "wrong wifi password";
    }
    return "?";
}

static void set_state(net_wifi_state_t state)
{
    s_state = state;
    if (s_cb) s_cb(state, s_cb_ctx);
}

static const char *reason_hint(uint8_t reason)
{
    switch (reason) {
    case WIFI_REASON_NO_AP_FOUND:
        return " (SSID not found; the S3 only sees 2.4 GHz networks)";
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
        return " (check the password)";
    default:
        return "";
    }
}

// A wrong password is worth telling apart from a network that simply is not here:
// retrying it for thirty seconds at a time never works, so it moves on at once.
static bool is_auth_failure(uint8_t reason)
{
    switch (reason) {
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_MIC_FAILURE:
        return true;
    default:
        return false;
    }
}

// Everything saved, in the order the store holds them. Used when there is nothing
// better to go on — on boot with a single network, or when a scan found nothing.
static void order_from_store(void)
{
    s_order_count = 0;
    for (int i = 0; i < wifi_store_count() && s_order_count < WIFI_STORE_MAX; i++) {
        const wifi_saved_t *e = wifi_store_at(i);
        if (e) strlcpy(s_order[s_order_count++], e->ssid, WIFI_SSID_LEN);
    }
    s_order_at = 0;
    s_fails = 0;
}

static void try_current(void)
{
    if (s_order_at >= s_order_count) {
        // Out of candidates. Look again rather than giving up — the network may come
        // back — but on the long backoff so this is not a tight scan loop.
        ESP_LOGW(TAG, "none of the %d saved networks worked; scanning again in %" PRIu32 " ms", s_order_count,
                 s_retry_ms);
        set_state(s_order_count ? NET_WIFI_NO_NETWORK : NET_WIFI_IDLE);
        if (wifi_store_count()) esp_timer_start_once(s_retry_timer, (uint64_t)s_retry_ms * 1000);
        s_retry_ms = MIN(s_retry_ms * 2, RETRY_MAX_MS);
        return;
    }

    const int at = wifi_store_index_of(s_order[s_order_at]);
    const wifi_saved_t *e = at >= 0 ? wifi_store_at(at) : NULL;
    if (!e) {
        // Forgotten between the scan and now.
        s_order_at++;
        try_current();
        return;
    }

    strlcpy(s_ssid, e->ssid, sizeof(s_ssid));
    wifi_config_t cfg = {
        .sta = {
            // From the network rather than hard-coded: WPA2_PSK as a floor rejects a
            // WPA3-only access point outright, and OPEN lets anything through.
            .threshold.authmode = e->password[0] ? WIFI_AUTH_WPA_WPA2_PSK : WIFI_AUTH_OPEN,
            .sae_pwe_h2e = WPA3_SAE_PWE_BOTH,
        },
    };
    strlcpy((char *)cfg.sta.ssid, e->ssid, sizeof(cfg.sta.ssid));
    strlcpy((char *)cfg.sta.password, e->password, sizeof(cfg.sta.password));
    esp_wifi_set_config(WIFI_IF_STA, &cfg);

    ESP_LOGI(TAG, "joining \"%s\"", e->ssid);
    set_state(NET_WIFI_CONNECTING);
    esp_wifi_connect();
}

static void begin_reconnect_scan(void)
{
    if (wifi_store_count() == 0) {
        set_state(NET_WIFI_IDLE);
        return;
    }
    // One saved network and nothing to choose between: connecting straight to it is
    // a second or two faster than scanning first, and it is the common case.
    if (wifi_store_count() == 1) {
        order_from_store();
        try_current();
        return;
    }
    if (s_scan_for_reconnect || s_scan_for_ui) return; // one at a time
    s_scan_for_reconnect = true;
    set_state(NET_WIFI_SCANNING);
    const wifi_scan_config_t scan = {.show_hidden = false};
    if (esp_wifi_scan_start(&scan, false) != ESP_OK) {
        s_scan_for_reconnect = false;
        order_from_store(); // scanning refused; fall back to trying them all
        try_current();
    }
}

static void retry_timer_cb(void *arg)
{
    begin_reconnect_scan();
}

static void collect_scan(void)
{
    // Static, not on the stack. This runs on the default event loop task, whose
    // stack is a couple of kilobytes, and a wifi_ap_record_t is well over a hundred
    // bytes — twenty-four of them overflowed it and panicked the device the first
    // time a scan ran. There is only ever one scan, so one buffer is enough.
    static wifi_ap_record_t records[SCAN_SLOTS];
    uint16_t found = SCAN_SLOTS;
    if (esp_wifi_scan_get_ap_records(&found, records) != ESP_OK) found = 0;

    s_seen_count = 0;
    for (int i = 0; i < found && s_seen_count < SCAN_SLOTS; i++) {
        const char *ssid = (const char *)records[i].ssid;
        if (!ssid[0]) continue;
        // The same network on two bands or two access points shows up twice; the
        // first is the strongest, since the driver sorts by RSSI.
        bool dup = false;
        for (int j = 0; j < s_seen_count; j++) {
            if (strcmp(s_seen[j].ssid, ssid) == 0) dup = true;
        }
        if (dup) continue;
        net_wifi_ap_t *ap = &s_seen[s_seen_count++];
        strlcpy(ap->ssid, ssid, sizeof(ap->ssid));
        ap->rssi = records[i].rssi;
        ap->open = records[i].authmode == WIFI_AUTH_OPEN;
        ap->saved = wifi_store_index_of(ssid) >= 0;
    }
    // No clear_ap_list here: esp_wifi_scan_get_ap_records already frees the driver's
    // copy, and calling both makes the second one complain.
}

static void on_scan_done(void)
{
    collect_scan();

    if (s_scan_for_ui) {
        s_scan_for_ui = false;
        ESP_LOGI(TAG, "scan found %d networks", s_seen_count);
        // A scan for the join screen must not disturb a live link, and it does not:
        // the driver keeps the association. If we were disconnected, the reconnect
        // logic is on its own timer and will come round again.
        return;
    }
    if (!s_scan_for_reconnect) return;
    s_scan_for_reconnect = false;

    // Saved networks that are actually here, strongest first, because s_seen already
    // is. This is the whole point of scanning rather than trying them blindly.
    s_order_count = 0;
    for (int i = 0; i < s_seen_count && s_order_count < WIFI_STORE_MAX; i++) {
        if (s_seen[i].saved) strlcpy(s_order[s_order_count++], s_seen[i].ssid, WIFI_SSID_LEN);
    }
    s_order_at = 0;
    s_fails = 0;
    if (!s_order_count) {
        ESP_LOGW(TAG, "%d networks in range, none of them saved", s_seen_count);
        set_state(NET_WIFI_NO_NETWORK);
        esp_timer_start_once(s_retry_timer, (uint64_t)s_retry_ms * 1000);
        s_retry_ms = MIN(s_retry_ms * 2, RETRY_MAX_MS);
        return;
    }
    try_current();
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        begin_reconnect_scan();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_SCAN_DONE) {
        on_scan_done();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_CONNECTED) {
        // Associated. Not online yet — that is GOT_IP — but the credentials are
        // right, which is what the failure count is about. Previously unhandled,
        // which is why a network that associated but never got a lease backed off
        // for ever.
        s_fails = 0;
        s_retry_ms = RETRY_MIN_MS;
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        const wifi_event_sta_disconnected_t *e = data;
        const bool was_connected = net_wifi_is_connected();
        xEventGroupClearBits(s_events, CONNECTED_BIT);

        if (is_auth_failure(e->reason)) {
            ESP_LOGW(TAG, "\"%s\" rejected us, reason %d%s; trying the next", s_ssid, e->reason,
                     reason_hint(e->reason));
            set_state(NET_WIFI_BAD_PASSWORD);
            s_order_at++;
            s_fails = 0;
            try_current();
            return;
        }

        if (++s_fails <= FAILS_BEFORE_NEXT) {
            ESP_LOGW(TAG, "dropped \"%s\", reason %d%s; retrying in %" PRIu32 " ms", s_ssid, e->reason,
                     reason_hint(e->reason), s_retry_ms);
            set_state(NET_WIFI_CONNECTING);
            esp_timer_start_once(s_retry_timer, (uint64_t)s_retry_ms * 1000);
            s_retry_ms = MIN(s_retry_ms * 2, RETRY_MAX_MS);
            // The timer rescans, which is right after a real loss. Re-associating
            // with the same network is what a scan will decide on anyway when it is
            // still the strongest thing here.
            return;
        }

        ESP_LOGW(TAG, "giving up on \"%s\" after %d tries", s_ssid, s_fails);
        s_order_at++;
        s_fails = 0;
        if (was_connected) {
            // The link we were on has gone: look around properly rather than working
            // down a list built who knows when.
            s_order_count = 0;
            s_order_at = 0;
            begin_reconnect_scan();
        } else {
            try_current();
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *e = data;
        ESP_LOGI(TAG, "\"%s\" up, ip " IPSTR, s_ssid, IP2STR(&e->ip_info.ip));
        s_retry_ms = RETRY_MIN_MS;
        s_fails = 0;
        xEventGroupSetBits(s_events, CONNECTED_BIT);
        set_state(NET_WIFI_CONNECTED);
    }
}

esp_err_t net_wifi_start(const net_wifi_config_t *cfg)
{
    s_cb = cfg->cb;
    s_cb_ctx = cfg->cb_ctx;
    s_events = xEventGroupCreate();
    if (!s_events) return ESP_ERR_NO_MEM;

    const esp_timer_create_args_t timer_args = {
        .callback = retry_timer_cb,
        .name = "wifi_retry",
    };
    ESP_ERROR_CHECK(esp_timer_create(&timer_args, &s_retry_timer));

    esp_netif_t *netif = esp_netif_create_default_wifi_sta();
    if (cfg->hostname) {
        ESP_ERROR_CHECK(esp_netif_set_hostname(netif, cfg->hostname));
    }

    const wifi_init_config_t init_cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init_cfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL));

    // Our own store is the only source of truth; the driver's NVS copy would be a
    // second one to keep in step.
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());
    // Modem sleep between beacons. This is probably what the default already was,
    // but inheriting it silently is not the same as choosing it: on a battery this
    // is the single biggest saving available, and it should be visible in the code
    // that it has been asked for.
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_MIN_MODEM));

    if (wifi_store_count() == 0) {
        // Not an error. The panel can add one, and everything that does not need the
        // network — the clock, the shell, the console — works meanwhile.
        ESP_LOGW(TAG, "no saved networks; add one in settings");
    }
    return ESP_OK;
}

bool net_wifi_wait_connected(TickType_t timeout)
{
    return xEventGroupWaitBits(s_events, CONNECTED_BIT, pdFALSE, pdTRUE, timeout) & CONNECTED_BIT;
}

bool net_wifi_is_connected(void)
{
    return s_events && (xEventGroupGetBits(s_events) & CONNECTED_BIT);
}

net_wifi_state_t net_wifi_state(void)
{
    return s_state;
}

const char *net_wifi_ssid(void)
{
    return s_ssid;
}

void net_wifi_retry_now(void)
{
    s_retry_ms = RETRY_MIN_MS;
    s_order_count = 0;
    s_order_at = 0;
    s_fails = 0;
    esp_timer_stop(s_retry_timer);
    if (net_wifi_is_connected()) {
        // Already up, and staying put is the whole policy. A newly added network is
        // for next time, not a reason to jump.
        ESP_LOGI(TAG, "already on \"%s\"; the new network will be used if this one drops", s_ssid);
        return;
    }
    begin_reconnect_scan();
}

esp_err_t net_wifi_scan_start(void)
{
    if (s_scan_for_reconnect || s_scan_for_ui) return ESP_ERR_INVALID_STATE;
    s_scan_for_ui = true;
    const wifi_scan_config_t scan = {.show_hidden = false};
    const esp_err_t err = esp_wifi_scan_start(&scan, false);
    if (err != ESP_OK) s_scan_for_ui = false;
    return err;
}

bool net_wifi_scan_busy(void)
{
    return s_scan_for_ui || s_scan_for_reconnect;
}

int net_wifi_scan_results(net_wifi_ap_t *out, int max)
{
    if (!out || max <= 0) return 0;
    const int n = s_seen_count < max ? s_seen_count : max;
    for (int i = 0; i < n; i++) {
        out[i] = s_seen[i];
        // Recomputed on the way out: something may have been saved or forgotten
        // since the scan, and a stale "saved" flag is what makes a list lie.
        out[i].saved = wifi_store_index_of(out[i].ssid) >= 0;
    }
    return n;
}
