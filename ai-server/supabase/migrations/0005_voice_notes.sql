-- Voice notes: a clip the device recorded hands-free, meant to be kept and listened
-- to rather than transcribed and answered. Same storage and the same table as every
-- other clip; only the source tells them apart, so the audio tab can split them into
-- their own list without a second pipeline.

alter table audio_clips drop constraint if exists audio_clips_source_check;
alter table audio_clips add constraint audio_clips_source_check
  check (source in ('mic', 'web', 'agent', 'note'));
