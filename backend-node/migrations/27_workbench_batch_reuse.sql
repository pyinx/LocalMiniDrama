-- A fill-missing operation may reuse a manual take, which keeps its original operation key.
ALTER TABLE video_batch_items ADD COLUMN reused_video_id INTEGER;
