const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { randomUUID } = require('node:crypto');
const { episodeStoryboardRows } = require('./episodeStoryboardRows');
const { bindStoryboardFrameImage } = require('./storyboardFrameBinding');
const { getFfmpegPath, hasLocalFfmpeg } = require('../utils/ffmpegPath');

/**
 * 尾帧衔接服务：提取当前分镜视频的最后一帧，设为下一个分镜的首帧
 */
function routes(db, cfg, log) {
  return {
    linkTailFrame: async (req, res) => {
      let unboundFile;
      try {
        const storyboardId = parseInt(req.params.id, 10);
        const body = req.body || {};
        const dramaId = body.drama_id;

        if (!storyboardId || !dramaId) {
          return res.status(400).json({ error: '缺少必要参数' });
        }

        const currentSb = db.prepare(`SELECT s.* FROM storyboards s JOIN episodes e ON e.id=s.episode_id
          WHERE s.id=? AND e.drama_id=? AND s.deleted_at IS NULL AND e.deleted_at IS NULL`).get(storyboardId, dramaId);
        if (!currentSb) return res.status(404).json({ error: '分镜不存在' });
        const takes = require('./workbenchTakeService');
        const video = takes.resolveTake(db, currentSb);
        if (!video?.local_path) return res.status(400).json({ error: '当前采用片没有可用的本地视频文件' });

        const nextBoard = () => {
          const rows = episodeStoryboardRows(db, currentSb.episode_id);
          const index = rows.findIndex(row => row.id === storyboardId);
          return index < 0 ? null : rows[index + 1];
        };
        const nextSb = nextBoard();

        if (!nextSb) {
          return res.status(400).json({ error: '没有下一个分镜可供衔接' });
        }
        if (body.next_storyboard_id != null && Number(body.next_storyboard_id) !== nextSb.id) {
          return res.status(409).json({ error: '下一镜已变化，请刷新后重新衔接' });
        }

        // 3. 检查 ffmpeg 是否可用
        if (!hasLocalFfmpeg()) {
          return res.status(500).json({ error: '服务器未安装 ffmpeg，无法提取视频帧' });
        }

        const ffmpeg = getFfmpegPath();

        // 4. 构建视频文件绝对路径
        // local_path 通常是相对路径，如 media/videos/xxx.mp4
        const rawStorage = cfg?.storage?.local_path || './data/storage';
        const storageBase = path.isAbsolute(rawStorage)
          ? rawStorage
          : path.join(process.cwd(), rawStorage);
        const videoAbsPath = takes.localFile(storageBase, video.local_path);
        if (!videoAbsPath) {
          return res.status(400).json({ error: '视频文件不存在: ' + video.local_path });
        }

        // 5. 准备输出图片路径
        const outputFileName = `tailframe_${storyboardId}_to_${nextSb.id}_${randomUUID()}.jpg`;
        const imagesDir = path.join(storageBase, 'media', 'images');
        if (!fs.existsSync(imagesDir)) {
          fs.mkdirSync(imagesDir, { recursive: true });
        }
        const outputAbsPath = path.join(imagesDir, outputFileName);
        unboundFile = outputAbsPath;
        const outputRelPath = `media/images/${outputFileName}`;

        // 6. 使用 ffmpeg 提取最后一帧
        // 从片尾附近解码到结束，image2 的 update 模式将实际最后一帧留在输出文件。
        log.info('[尾帧衔接] 开始提取', { from: video.local_path, to: outputRelPath });

        const result = spawnSync(ffmpeg, [
          '-sseof', '-2',
          '-i', videoAbsPath,
          '-update', '1',
          '-q:v', '2',
          '-y',
          outputAbsPath
        ], { encoding: 'utf8', timeout: 60000 });

        if (result.error || result.status !== 0) {
          log.error('[尾帧衔接] ffmpeg 失败', { stderr: result.stderr?.slice(-500) });
          return res.status(500).json({ error: 'ffmpeg 提取帧失败: ' + (result.stderr || result.error?.message || '未知错误') });
        }

        if (!takes.localFile(storageBase, outputRelPath)) {
          return res.status(500).json({ error: '提取帧后文件未生成' });
        }

        // 7. 获取图片尺寸（可选，用于记录）
        let width = null, height = null;
        try {
          const { getFfprobePath } = require('../utils/ffmpegPath');
          const ffprobe = getFfprobePath && getFfprobePath();
          if (ffprobe) {
            const probe = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', outputAbsPath], { encoding: 'utf8' });
            if (probe.stdout) {
              const [w, h] = probe.stdout.trim().split('x');
              width = w ? parseInt(w, 10) : null;
              height = h ? parseInt(h, 10) : null;
            }
          }
        } catch (_) { /* 忽略尺寸探测错误 */ }

        // 8. 在 image_generations 表创建记录
        const now = new Date().toISOString();
        const prompt = `尾帧衔接：从分镜 #${currentSb.storyboard_number ?? storyboardId} 视频提取的最后一帧`;

        const insert = db.prepare(`
          INSERT INTO image_generations (
            drama_id, episode_id, storyboard_id, prompt, provider, model, status,
            image_url, local_path, width, height,
            created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        // 假设有 files_base_url 配置
        const filesBase = cfg?.files?.base_url || '';
        const imageUrl = filesBase ? `${filesBase.replace(/\/$/, '')}/${outputRelPath}` : null;

        const newImageId = db.transaction(() => {
          if (nextBoard()?.id !== nextSb.id) throw Object.assign(new Error('镜序已变化，请刷新后重新衔接'), { status: 409 });
          const source = db.prepare('SELECT * FROM storyboards WHERE id=? AND deleted_at IS NULL').get(storyboardId);
          const effective = takes.resolveTake(db, source);
          if (effective?.id !== video.id || effective?.local_path !== video.local_path) {
            throw Object.assign(new Error('源镜头视频已变化，请刷新后重新衔接'), { status: 409 });
          }
          const info = insert.run(dramaId, currentSb.episode_id, nextSb.id, prompt, 'tail-frame',
            'tail-frame-extract', 'completed', imageUrl, outputRelPath, width, height, now, now, now);
          if (!bindStoryboardFrameImage(db, nextSb.id, 'first', info.lastInsertRowid, imageUrl, outputRelPath)) {
            throw new Error('目标分镜首帧未写入');
          }
          return info.lastInsertRowid;
        }).immediate();
        unboundFile = null;

        log.info('[尾帧衔接] 完成', {
          from_storyboard: storyboardId,
          to_storyboard: nextSb.id,
          new_image_id: newImageId,
          prev_first_frame_id: nextSb.first_frame_image_id
        });

        res.json({
          success: true,
          message: '尾帧衔接成功',
          next_storyboard_id: nextSb.id,
          new_first_frame_image_id: newImageId,
          image_url: imageUrl,
          local_path: outputRelPath
        });

      } catch (err) {
        log.error('storyboards link-tail-frame', { error: err.message, stack: err.stack });
        res.status(err.status || 500).json({ error: err.message || '尾帧衔接失败' });
      } finally {
        if (unboundFile) {
          try { fs.rmSync(unboundFile, { force: true }); }
          catch (err) { log.warn('尾帧临时文件清理失败', { file: unboundFile, error: err.message }); }
        }
      }
    }
  };
}

module.exports = routes;
