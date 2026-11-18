ALTER TABLE storyboards ADD COLUMN adopted_video_generation_id INTEGER REFERENCES video_generations(id);
ALTER TABLE storyboards ADD COLUMN take_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE video_generations ADD COLUMN keep_in_archive INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS video_take_reviews (
  id INTEGER PRIMARY KEY,
  video_generation_id INTEGER NOT NULL REFERENCES video_generations(id),
  time_ms INTEGER NOT NULL CHECK (time_ms >= 0),
  note TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_video_take_reviews_video ON video_take_reviews(video_generation_id);
CREATE INDEX IF NOT EXISTS idx_take_storyboard_status ON video_generations(storyboard_id, status, created_at);
