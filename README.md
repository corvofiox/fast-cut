# Fast Cut

极简 Windows 视频裁剪工具。核心承诺是**流拷贝导出**：不转码、不改画质、不重封装音频，
切点自动前移到最近的关键帧，几百 MB 到几十 GB 的素材都是秒级出片。

交互按**键位优先**设计：没有入点 / 出点 / 分割 / 删除 / 缩放这些按钮，剪辑动作全走键盘
（`W` 分割、`Q` / `E` 涟漪删除、`J K L` 变速、`,` `.` 逐帧、`Shift+←/→` 跳关键帧、
`Ctrl+Z` / `Ctrl+Y` 撤销重做）。时间轴上顶部一条是刻度尺兼播放头手柄，下面整条胶片可以
拖动改片段顺序、单击选中，两者都不会移动播放头。

## 环境

- Windows 10/11，Node.js 20+
- `npm install`

### 构建 exe 前需要自备 ffmpeg

`vendor/ffmpeg/` 里要放 `ffmpeg.exe` 与 `ffprobe.exe`（该目录被 `.gitignore` 排除，不入库）。
electron-builder 会把它复制进 `resources/ffmpeg`，打包版**只用内置的这一份**，不提供用户覆盖入口。
注意：常见的公开构建是 GPL 编译的，自行分发 exe 时需一并履行相应义务。

## 命令

```bash
npm start              # 开发运行
npm run core:test      # 剪辑内核单元测试
npm run smoke          # 端到端自检：开真窗口跑完整剪辑 + 导出 + 时间轴交互
npm run core:codecs    # 编解码矩阵：5 种容器/编码 × 3 种导出模式
npm run dist           # 打包 → dist/Fast-Cut-<版本>-x64.exe（免安装，双击即用）
npm run dist:dir       # 只出 dist/win-unpacked/，调打包配置时快得多
```

## 文档

- [docs/01-需求文档.md](docs/01-需求文档.md) — 功能范围、交互约定、非目标
- [docs/02-技术方案.md](docs/02-技术方案.md) — 架构、ffmpeg 参数与踩坑记录、自检清单、打包

## 隐私

无遥测、无网络请求。导出只写用户指定的目标文件：目标已存在或目标就是源文件时直接拒绝，
绝不覆盖用户的素材。

## 许可

MIT（见 `package.json`）。内置 ffmpeg 二进制的许可见上节说明。
