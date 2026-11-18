ALTER TABLE video_generations ADD COLUMN operation_key TEXT;
ALTER TABLE video_generations ADD COLUMN dispatch_state TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS video_operation_key ON video_generations(operation_key) WHERE operation_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS video_batch_items (
  episode_id INTEGER NOT NULL,
  storyboard_id INTEGER NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  PRIMARY KEY (episode_id, storyboard_id)
);
