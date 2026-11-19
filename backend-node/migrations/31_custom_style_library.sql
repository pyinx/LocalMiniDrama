CREATE TABLE IF NOT EXISTS style_example_images (
  digest TEXT PRIMARY KEY,
  content BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS custom_style_versions (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  positive TEXT NOT NULL,
  negative TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL REFERENCES style_example_images(digest),
  PRIMARY KEY (id, version)
);
ALTER TABLE video_generations ADD COLUMN style_negative TEXT;
ALTER TABLE image_generations ADD COLUMN style_snapshot TEXT;
