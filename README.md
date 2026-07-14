# RemyMaker

RemyMaker 是一款面向桌面端与手机端的 3D Gaussian Splatting 特效与镜头运镜工具。它支持加载 Remy3D 和 Kiri Engine 分享链接，在粒子模式与 3D 实景之间切换，并通过内置或自定义镜头路径导出高清视频。

## 在线体验

**Demo：[https://remymaker.pages.dev/](https://remymaker.pages.dev/)**

建议使用最新版 Chrome、Edge 或 Safari。视频导出能力和最终格式取决于浏览器对 MediaRecorder、MP4 与 WebM 的支持。

## 功能亮点

- 粒子模式与 3D 实景平滑切换
- 粒子大小、亮度、密度、透明度、羽化与背景裁剪调节
- 9 种粒子消散与重组特效，15 套镜头运镜预设，包括环绕、8 字、螺旋与 Dolly Zoom
- 支持选择 2–8 个关键帧，进行无限制的自定义运镜
- 运镜预览、粒子聚合与视频导出组合工作流
- 桌面端 1080p、60 FPS、20 Mbps 视频导出
- 手机端按屏幕比例导出 1080p、30 FPS、15 Mbps 视频
- 支持中英文界面与响应式手机布局
- 桌面端支持 MediaPipe 手势控制

## 手势控制

桌面端可启用 MediaPipe Gesture Recognizer：

- 🖐️张开手掌：提高粒子消散进度
- ✊握拳：降低粒子消散进度
- 👆食指指向：控制模型视角
- ✊✊双拳靠近远离：缩放模型
- ✌️剪刀手：停留 1 秒，在粒子模式 / 3D 实景间切换

识别逻辑包含置信度、历史帧投票、稳定帧计数和手部方向过滤，以减少误操作。

## 支持链接

- [Remy3D](https://www.remy3d.cn/) 分享链接
- [Kiri Engine](https://www.kiriengine.app/) 3DGS 分享链接

## 使用 Skill 本地运行

- 向你使用的 Agent 发送下面这段话：

  `  请将 https://github.com/willjim/RemyMaker 中名为 remymaker-local 的 skill 安装到本地`

- 完成后发送「帮我运行remy」或「帮我运行remymaker」即可在本地运行本项目。

## 项目结构

```text
RemyMaker/
├── index.html
├── guide.html
├── css/
│   └── style.css
├── js/
│   ├── app.js
│   ├── gestureControl.js
│   ├── landingBackground.js
│   ├── particleSystem.js
│   ├── plyParser.js
│   └── remyLoader.js
├── functions/
│   └── resolve.js
├── .pagesignore
├── README.md
└── wrangler.toml
```

## 开源技术致谢

RemyMaker 的实现离不开以下优秀项目与工具，在此向所有维护者和贡献者表示感谢：

- [Three.js](https://threejs.org/) — WebGL 3D 渲染基础
- [Spark](https://sparkjs.dev/) — 3D Gaussian Splatting 渲染
- [MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/guide) — 手势识别
- [GSAP](https://gsap.com/) — 镜头路径与界面动画
- [fix-webm-duration](https://github.com/yusitnikov/fix-webm-duration) — WebM 时长修复
- [Cloudflare Pages](https://pages.cloudflare.com/) — 网页托管与 Functions 运行环境
- [KIRI Engine](https://www.kiriengine.app) 全体小伙伴
