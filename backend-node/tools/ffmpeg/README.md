# FFmpeg 本地目录

Windows x64 已随附同一发行包的 `ffmpeg.exe` 与 `ffprobe.exe`。前者负责编码和滤镜测量，后者读取音轨、画幅及时长。Windows 桌面版将两者打包，首次启动或升级时补上本机缺少的工具。

## 手动替换工具（Windows）

- `ffmpeg.exe`
- `ffprobe.exe`

随附版本为 Gyan 8.0.1 essentials，原始 7z 的 SHA-256 为 `a0c715acca3839bfd203e600a7775b83cfe3ff928a4eceb9ca54f2982365901c`，其中 ffprobe 的 SHA-256 为 `192a1d6899059765ac8c39764fc3148d4e6049955956dc2029f81f4bd6a8972d`。[发行包及对应源码](https://github.com/GyanD/codexffmpeg/releases/tag/8.0.1) · [随附许可证](LICENSE.txt)

## 一键拷贝（可选）

若你的 ffmpeg 在 `D:\Program Files\ffmpeg-8.0.1-essentials_build\bin`，可在 **backend-node** 目录下执行：

```bash
node scripts/copy-ffmpeg.js "D:\Program Files\ffmpeg-8.0.1-essentials_build\bin"
```

会复制 `ffmpeg.exe` 和 `ffprobe.exe` 到本目录。

## 路径优先级

1. 已配置且存在的 `FFMPEG_PATH`、`FFPROBE_PATH`
2. 应用工作目录及可执行文件附近的工具，再查本目录
3. 系统 PATH
