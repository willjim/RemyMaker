# RemyMaker 性能与 Spark 2 优化审查

## 当前渲染链路概览

- 应用在加载模型时会同时构建 Three.js 粒子云与 Spark 2 `SplatMesh`：`processBuffer()` 先解析 PLY 得到粒子数据，再创建 `SplatMesh`，因此一次加载会承担两套数据结构和两套 GPU 资源的成本。
- Spark 2 已经按需动态导入，且 WebGLRenderer 关闭抗锯齿并使用 `high-performance`，这是正确的 Spark 2 基线配置。
- 粒子云目前负责消散、聚合、过渡和导出时的特效表现；Spark 2 负责写实 3DGS 层。

## 优先优化建议

### P0：把 Spark 模式作为快速路径，避免每次都解析整份 PLY 给粒子系统

现在无论用户最终是否使用 Spark 写实模式，`processBuffer()` 都会先调用 `parsePLY()`，并随后创建 `ParticleSystem`。这会在大模型上造成 CPU 解析、TypedArray 分配、Morton 排序和 shader 属性上传的固定成本。建议增加“Spark-first”路径：

1. 首次加载时立即创建 Spark `SplatMesh`，让用户先看到 3DGS 画面。
2. 只有用户切到粒子模式、播放粒子特效或导出需要粒子特效时，才异步构建 `ParticleSystem`。
3. 粒子系统构建期间保留 Spark 可交互渲染，构建完成后再启用粒子按钮或显示进度。

预期收益：首屏时间和大模型内存占用显著下降，最能体现 Spark 2 的“直接渲染 splat 数据”优势。

### P0：减少粒子系统的 CPU 排序与属性内存

`ParticleSystem.createFromData()` 会为每个粒子生成随机方向、速度、相位、重要性、Morton code、排序索引，并重排多个 Float32 属性。对 50 万点，这部分会产生大量临时数组与主线程排序开销。建议：

- 只在粒子模式真正需要时执行该逻辑。
- 将随机方向、速度、相位改为 shader 中通过位置 hash 生成，减少 5 个 CPU 属性与重排成本。
- 对粒子密度使用 `geometry.setDrawRange()` 或固定顺序抽样，避免为了密度/重要性进行两次 TypedArray 排序。
- 如果保留空间均匀抽样，建议改成离线/Worker 预处理，避免阻塞主线程。

### P0：导出下载路径不要在主线程把 Splat 全量转成 PLY

下载按钮对 compressed splat 会重新 `parsePLY()`，设置 `maxParticles: 2000000`，再 `exportToPLY()` 全量写出标准 PLY。这会和 Spark 2 的直接加载优势相反：下载操作可能造成明显卡顿和峰值内存飙升。建议：

- 默认下载原始 splat/PLY buffer。
- 如果必须提供 PLY 转换，把转换放到 Web Worker，并显示可取消进度。
- 对移动端禁用全量转换或限制最大点数。

### P1：利用 Spark 2 渲染层，减少过渡期双渲染时长

动画循环会根据 `splatInterpolation` 同时更新粒子透明度和 Spark opacity，并在过渡中两者短暂同时可见。双渲染对移动端尤其昂贵。建议：

- 按设备能力缩短交叉淡入时长，低端设备直接硬切 Spark/粒子。
- 当 `splatInterpolation` 接近 0 或 1 时，尽早将不可见对象 `visible=false` 并跳过粒子 `update()`。
- Spark 模式下如果没有粒子特效，完全暂停粒子系统时间、uniform 和 draw range 更新。

已落地的交互优化：3DGS 模式会降低交互态 pixel ratio 上限，以减少每帧像素填充压力；视频导出路径仍按导出逻辑设置固定分辨率。不要在预览/导出运镜中限制 Spark 排序频率或强制 LoD，否则可能出现排序滞后、模型左右摇摆或画面“粘滞感”。

### P1：把解析、裁剪、抽样迁移到 Web Worker

`parsePLY()` 包含 header 解析、采样、自动裁剪统计、颜色/opacity/scale/rotation 读取和数组裁剪，全部在主线程执行。建议将 PLY 解析和粒子数据生成迁移到 Worker，并使用 Transferable ArrayBuffer/TypedArray 返回结果。这样 Spark 2 可先加载和渲染，粒子数据在后台准备。

### P1：避免为粒子模式解析不使用的 3DGS scale/rotation/opacities

粒子系统只使用 `positions`、`colors`、`count`，但 `parsePLY()` 仍为标准二进制 PLY 分配并填充 `scales`、`rotations`、`opacities`。这些数据主要服务于 PLY 导出，而不是粒子渲染。建议给 `parsePLY()` 增加 `includeSplatAttributes` 参数：

- 粒子预览：只解析位置和颜色。
- PLY 导出：才解析 scale、rotation、opacity。

### P2：Landing 背景按设备降级

首页银河背景固定创建 22,000 个粒子，并持续更新材质 size。桌面端问题不大，但移动端和低端设备可以降级到 6,000–10,000 粒子，或在用户加载模型后立即 dispose 背景几何和纹理，而不仅仅隐藏。

## 可删除或清理的冗余代码

1. `cropPLYBufferDirect` 已从 `plyParser.js` 导出，并在 `app.js` 中导入，但当前没有实际调用。若不再提供“裁剪后下载原始 PLY”功能，可删除该函数和导入。
2. 隐藏的 Upload/Download UI 如果产品上不打算开放，会带来事件、翻译和导出代码维护成本。建议二选一：正式显示并支持，或删除相关 DOM、状态与事件处理。
3. `LandingBackground.generateGalaxy()` 中 `coreCount` 恒为 0，只用于背景星索引计算，可直接移除并把索引改为 `armCount + i`。
4. 粒子系统中的 `setSplatScale()` 和若干 no-op 方法仅为旧调用兼容保留；完成调用侧迁移后可删除，避免误导后续维护。
5. `parsePLY()` 中服务于导出的 `exportToPLY()` 链路如果改为默认下载原始 splat，可从默认加载路径中拆出去，降低主包心智负担。

## 建议实施顺序

1. 先做 Spark-first 懒加载粒子系统，保留现有交互行为不变。
2. 给 PLY parser 增加“只读粒子预览字段”模式，减少默认内存。
3. 将粒子数据生成迁移到 Worker。
4. 重构下载：默认原始 buffer，转换 PLY 走 Worker/高级选项。
5. 清理无调用函数、隐藏 UI 或旧兼容 no-op。

## 风险与验证要点

- Spark-first 后，需要确保镜头初始位置、坐标翻转和粒子系统最终对齐仍一致。
- 懒加载粒子系统时，粒子特效按钮需要有 loading/disabled 状态。
- Worker 化后要验证 ArrayBuffer 所有权转移，不要把 Spark 正在使用的 buffer 转走；需要复制或传输独立 buffer。
- 移除下载转换前，要确认用户是否依赖“splat 转标准 PLY”的隐藏能力。
