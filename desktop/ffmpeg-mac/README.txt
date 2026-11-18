在 desktop 目录运行 python3 scripts/prepare-mac-media.py，可准备包含 arm64 与 x86_64 的 ffmpeg 和 ffprobe。npm run dist:mac 会执行同一步。已有双架构工具可继续使用。

licenses/MEDIA-TOOLS-SOURCES.json 记录各架构使用的发行包、原始二进制 SHA-256 和源码地址。该目录随桌面应用分发。

首次启动时，应用将缺少的工具复制到 ~/Library/Application Support/localminidrama-desktop/backend/tools/ffmpeg/。
