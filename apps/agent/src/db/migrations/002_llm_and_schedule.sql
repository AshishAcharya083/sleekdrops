-- Admin-settable LLM provider + autonomous scout schedule.
--
-- 'llm': {"base_url": "...", "api_key": "...", "default_model": "..."} —
--   any field empty/absent falls back to apps/agent/.env. Lets the admin
--   panel switch between OpenRouter / any OpenAI-compatible provider live.
-- 'scout_interval_hours': how often the topic scout runs on its own
--   (24 = daily). 0 disables autonomous scouting.
INSERT INTO settings (key, value) VALUES
  ('llm', '{}'::jsonb),
  ('scout_interval_hours', '24'::jsonb)
ON CONFLICT (key) DO NOTHING;
