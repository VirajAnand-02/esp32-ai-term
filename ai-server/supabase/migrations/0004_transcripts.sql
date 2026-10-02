-- Speech to text. Clips recorded on a device can be transcribed with Groq
-- (whisper-large-v3-turbo); the text is kept next to the clip so the dashboard
-- can show it again without paying for a second pass.

alter table audio_clips add column if not exists transcript text;
alter table audio_clips add column if not exists transcript_model text;
