-- Audio clips recorded on devices. The WAV bytes live in Supabase Storage
-- (private bucket "clips"); this table holds the metadata and the object path.

create table if not exists audio_clips (
  id          uuid primary key default gen_random_uuid(),
  device_id   uuid not null references devices (id) on delete cascade,
  session_id  uuid references sessions (id) on delete set null,
  path        text not null,                  -- object path inside the clips bucket
  seconds     real not null default 0,
  sample_rate integer not null default 16000,
  channels    smallint not null default 1,
  bytes       integer not null default 0,
  peak        real,                           -- 0..1, loudest sample in the clip
  source      text not null default 'mic'
              check (source in ('mic', 'web', 'agent')),
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists audio_clips_device_idx on audio_clips (device_id, created_at desc);

alter table audio_clips enable row level security;
revoke all on audio_clips from anon, authenticated;
grant all on audio_clips to service_role;
