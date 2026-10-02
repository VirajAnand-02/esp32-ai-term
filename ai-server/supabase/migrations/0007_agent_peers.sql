-- Attached agent harnesses (OpenClaw, NanoClaw, Hermes) as peers.
--
-- A peer is a device whose transport is HTTP-out instead of WebSocket-in: we call its
-- OpenAI-compatible /v1/chat/completions rather than waiting for it to connect to /ws.
-- Modelling it as a device row is what gives it a name, an id, a token, event
-- attribution and a line in the fleet roster for free -- the same trick
-- ensureWebConsoleDevice() already plays for the dashboard.

alter table devices drop constraint if exists devices_kind_check;
alter table devices add constraint devices_kind_check
  check (kind in ('esp32', 'web', 'cli', 'other', 'agent'));

-- A sidecar table rather than devices.config, for one reason: config is in the
-- COLUMNS list every listDevices() selects, so it reaches the browser. The outbound
-- key cannot be hashed the way token_hash is -- we have to send it to the harness --
-- so it has to live somewhere the device reads never touch.
create table if not exists agent_peers (
  device_id  uuid primary key references devices (id) on delete cascade,
  base_url   text not null,                     -- e.g. https://box.tailnet.ts.net:18789
  api_key    text,                              -- the harness's bearer token, plaintext
  model      text,                              -- optional; passed through as "model"
  timeout_s  integer not null default 900 check (timeout_s between 10 and 3600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table agent_peers enable row level security;
-- No policies, like every other table in 0001: everything goes through the secret key.
