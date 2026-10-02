#pragma once

// ─── AI-TERM server ───────────────────────────────────────────────────────
// Where this terminal connects. Change the host after deploying the server:
//   local dev : "ws://192.168.29.121:3000/ws"
//   Railway   : "wss://<your-app>.up.railway.app/ws"
// #define AITERM_SERVER_URI "ws://192.168.29.121:3000/ws"
#define AITERM_SERVER_URI "wss://esp32-ai-term.onrender.com/ws"

// The device token from the dashboard (Settings → Devices) lives in
// wifi_credentials.h next to the Wi-Fi password, so this file stays shareable.

// Name reported to the network (mDNS + DHCP): reachable as <hostname>.local
#define AITERM_HOSTNAME "ai-term"

// What the agent may do on this device. The firmware's tools are all harmless
// (they only drive the on-board LED), so they run without asking.
#define AITERM_ACCESS_LEVEL   "standard"
#define AITERM_REMOTE_APPROVAL false

#define AITERM_FIRMWARE "esp32-ai-term 0.2.0"
