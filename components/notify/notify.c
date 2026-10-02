#include <string.h>
#include <time.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "bsp.h"
#include "notify.h"

static const char *TAG = "notify";

static struct {
    notify_entry_t items[NOTIFY_MAX];
    int count; // how many of the ring are valid, never more than NOTIFY_MAX
    int next;  // where the next one is written
    SemaphoreHandle_t lock;
} n;

static void lock(void)
{
    if (n.lock) xSemaphoreTake(n.lock, portMAX_DELAY);
}

static void unlock(void)
{
    if (n.lock) xSemaphoreGive(n.lock);
}

// Callers hold the lock.
static int unread_locked(void)
{
    int unread = 0;
    for (int i = 0; i < n.count; i++) {
        if (!n.items[i].read) unread++;
    }
    return unread;
}

// The LED and the store must not disagree, so every path that changes the unread
// count ends here rather than at the call site.
static void sync_led_locked(void)
{
    bsp_status_led_notify(unread_locked() > 0);
}

void notify_init(void)
{
    memset(&n, 0, sizeof(n));
    n.lock = xSemaphoreCreateMutex();
}

void notify_post(const char *title, const char *body)
{
    if (!title || !*title) return;
    lock();
    notify_entry_t *e = &n.items[n.next];
    n.next = (n.next + 1) % NOTIFY_MAX;
    if (n.count < NOTIFY_MAX) n.count++;

    // time() rather than the clock component: SNTP and the server's time both go
    // through settimeofday, so this is the same answer without the dependency. It
    // reads as 1970 before either has arrived, which is what `at == 0` is for.
    const time_t now = time(NULL);
    e->at = now > 1000000000 ? now : 0;
    strlcpy(e->title, title, sizeof(e->title));
    strlcpy(e->body, body ? body : "", sizeof(e->body));
    e->read = false;
    sync_led_locked();
    const int unread = unread_locked();
    unlock();
    ESP_LOGI(TAG, "%s: %s (%d unread)", title, body ? body : "", unread);
}

int notify_count(void)
{
    return n.count;
}

int notify_unread(void)
{
    lock();
    const int unread = unread_locked();
    unlock();
    return unread;
}

const notify_entry_t *notify_at(int index)
{
    if (index < 0 || index >= n.count) return NULL;
    // Newest first. next points one past the newest, so walk back from there.
    const int slot = (n.next - 1 - index + 2 * NOTIFY_MAX) % NOTIFY_MAX;
    return &n.items[slot];
}

void notify_mark_all_read(void)
{
    lock();
    for (int i = 0; i < n.count; i++) n.items[i].read = true;
    sync_led_locked();
    unlock();
}

void notify_clear(void)
{
    lock();
    n.count = 0;
    n.next = 0;
    memset(n.items, 0, sizeof(n.items));
    sync_led_locked();
    unlock();
}
