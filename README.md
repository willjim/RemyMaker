# RemyMaker

RemyMaker 是一款面向桌面端、平板与手机端的 3D 高斯泼贱特效和运镜工具。它支持加载 Remy3D、Kiri Engine 与 Insta360 分享链接，在粒子模式和 3D 实景之间切换，并通过内置运镜预设或自定义关键帧导出高清视频。

## 在线体验

**Demo：[点击前往](https://remymaker.pages.dev/)**

建议使用最新版 Chrome、Edge 或 Safari。支持 WebCodecs 的浏览器会优先逐帧合成 MP4；不支持 WebCodecs 时使用 MediaRecorder 兼容导出，最终格式可能为 MP4 或 WebM。

## 支持链接

- [Remy3D](https://www.remy3d.cn/) 分享链接
- [Kiri Engine](https://www.kiriengine.app/) 3DGS 分享链接
- Insta360 3D 时光舱分享链接

## 功能亮点

- 粒子模式与 3D 实景平滑切换，可暂停模型自动旋转
- 粒子大小、粒子亮度、密度和背景裁剪调节
- 11 种粒子消散重组特效，并提供「无需粒子特效」选项
- 19 套内置镜头运镜预设，包括水平环绕、希区柯克变焦、盗梦空间缓慢推进旋转及空间场景运镜等
- 运镜预览期间可切换粒子与 3D 实景，导出时复现切换时间点
- 可调整运镜、粒子动画与模式过渡时长，设置粒子开始时间及聚合／消散方向
- 支持高斯椭球从画外飞入组装，以及裁剪、擦除后主体的实景粒子叠加
- 支持自定义关键帧运镜，逐帧合成高帧率视频导出
- 桌面端支持 MediaPipe 手势控制

## 自定义关键帧

- 自定义运镜至少需要 2 个关键帧，桌面端和平板不限制关键帧数量，手机端最多记录 10 个关键帧
- 默认自动分配运镜节奏，可调整总时长；也可切换为手动设置相邻关键帧之间的秒数
- 点击已添加的「视角」可返回记录时的相机位置与角度
- 路径会过滤视角调整过程中无意产生的整体平移，并对角度与速度进行平滑处理，减少帧间停顿和意外整圈旋转
- 完成视频导出后会记住首帧，再次进入运镜预览时仍从已设置的位置与角度开始

在「时间设置」中可调整内置运镜总时长、粒子动画开始时间和持续时间，选择聚合、消散或聚合后消散。视频始终按运镜时长结束，超出部分的特效会截断。

模式过渡可选择渐变或椭球飞入，飞入方向支持四周、左、右、上、下。「实景叠加粒子」保留实景，让主体粒子独立运动并淡出；网页内裁剪和已确认擦除的背景不会参与叠加。

## 手势控制

桌面端可启用 MediaPipe Gesture Recognizer：

- 🖐️张开手掌：提高粒子消散进度
- 👊握拳：降低粒子消散进度
- ☝️食指指向：控制模型视角
- 👊👊双拳靠近或远离：缩放模型
- ✌️剪刀手：保持 0.7 秒，在粒子模式与 3D 实景之间切换

识别逻辑包含置信度判断、历史帧投票、连续稳定帧计数、手部方向过滤，以及消散进度首尾各 5% 的缓冲区，以减少误操作。

## 使用 Skill 本地运行

向所使用的 Agent 发送：

`请将 https://github.com/willjim/RemyMaker 中名为 remymaker-local 的 skill 安装到本地`

安装完成后发送「帮我运行 remy」或「帮我运行 remymaker」，即可启动本地网页。

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
│   ├── remyLoader.js
│   ├── sceneParticleOverlay.js
│   └── splatEffects.js
├── functions/
│   └── resolve.js
├── skills/
│   └── remymaker-local/
│       ├── SKILL.md
│       ├── scripts/
│       │   └── serve.py
│       └── assets/
│           └── remymaker-site/
├── .gitignore
├── .pagesignore
├── LICENSE
├── README.md
└── wrangler.toml
```

## 致谢

RemyMaker 的实现离不开以下优秀项目与工具，在此向所有维护者和贡献者表示感谢：

- [Three.js](https://threejs.org/) — WebGL 3D 渲染基础
- [Spark](https://sparkjs.dev/) — 3D Gaussian Splatting 渲染
- [MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/guide) — 手势识别
- [Mediabunny](https://mediabunny.dev/) — WebCodecs 视频封装与 MP4 输出
- [Tabler Icons](https://github.com/tabler/tabler-icons) — MIT 许可的界面 SVG 图标
- [fix-webm-duration](https://github.com/yusitnikov/fix-webm-duration) — WebM 时长修复
- [Cloudflare Pages](https://pages.cloudflare.com/) — 网页托管与 Functions 运行环境
- [KIRI Engine](https://www.kiriengine.app/) 团队

## License

本项目采用 [MIT License](LICENSE)。

Copyright (c) 2026 Willjim
