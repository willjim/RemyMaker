/**
 * Main Application
 * Orchestrates Three.js scene, PLY loading, particle system, and gesture control.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parsePLY, exportToPLY, cropPLYBufferDirect } from './plyParser.js';
import { ParticleSystem } from './particleSystem.js?v=3.5';
import { GestureControl } from './gestureControl.js';
import { extractPLYFromUrl, downloadPLY } from './remyLoader.js';
import fixWebmDuration from 'fix-webm-duration';
import { LandingBackground } from './landingBackground.js';

const MAX_INTERACTIVE_PIXEL_RATIO = 1.5;
const RENDERER_VISIBILITY_EPSILON = 0.002;
// ============================================================
// App State
// ============================================================
const state = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  clock: null,
  particleSystem: null,
  landingBg: null,
  cameraParallax: { x: 0, y: 0 },
  mouseTarget: { x: 0, y: 0 },
  gestureControl: null,
  sparkRenderer: null,
  splatMesh: null,
  splatPivot: null,
  lang: localStorage.getItem('splat-lang') || 'zh', // default language
  isModelLoaded: false,
  isGestureActive: false,
  manualControl: false,     // true when user drags the slider
  splatInterpolation: 0.0,   // default starts fully at Particle Cloud (0.0)
  splatInterpolationTarget: 0.0,
  fps: 0,
  frameCount: 0,
  lastFpsTime: 0,
  lastProgressPercent: -1,
  rendererVisibility: { particles: null, spark: null },
  initialCameraPosition: null, // Initial camera position from cameras.json
  lastLoadedBuffer: null,   // cache raw buffer for fast re-parsing on settings change
  lastLoadedName: '',
  modelScale: 1.0,          // base uniform scale computed on load
  modelCenter: null,        // base center calculated on load
  lastGesture: 'none',     // track last gesture for state transition triggers
  modelZoomScale: 1.0,      // current overall model scale factor
  initialZoomDist: null,    // distance when zoom gesture started
  initialZoomScale: 1.0,    // scale when zoom gesture started
  keyframes: [],            // array of { position: THREE.Vector3, target: THREE.Vector3 }
  cameraModeActive: false,  // true when camera path panel is visible
  previewActive: false,     // true during flight preview
  previewTime: 0.0,
  previewStart: null,
  gatherAnimationId: null,
  cancelScatterAnimation: null,
  recordingActive: false,   // true during flight recording
  recordingFps: 60,
  recordTime: 0.0,
  xFlipped: true,           // true when model X-axis is flipped (flipped by default on load)
  presetAnimation: null,    // GSAP tween for flight presets
  presetProgressObj: { value: 0 }, // progress target wrapper for GSAP
  settings: {
    renderer: 'particles',  // default is particles (point cloud)
    maxParticles: 500000,
    cropOutliers: true,
    cropFactor: 2.5,
    minOpacity: 0.50,
    pointSize: 0.20,         // default point size 0.20 for soft overlapping glow dots (AdditiveBlending)
    pointDensity: 1.00,      // default point cloud density (100%)
    particleBrightness: 0.70, // default particle brightness multiplier
    particleSoftness: 0.70,   // default softness multiplier
    particleOpacity: 1.00,    // default particle opacity multiplier
    splatScale: 1.0,
    presetFlight: 'none',   // active preset flight
    originalFov: 60.0,      // camera base field of view
    flightStartSpherical: { radius: 1.0, phi: Math.PI / 2, theta: 0 }, // cache starting spherical coords
    scatterEffect: 0.0,     // active scatter effect index (0 to 14)
    particleEffectEnabled: false,
  }
};
// ============================================================
// DOM References
// ============================================================
let dom = {};
function cacheDom() {
  dom = {
    container: document.getElementById('canvas-container'),
    urlInput: document.getElementById('url-input'),
    btnLoad: document.getElementById('btn-load'),
    btnUpload: document.getElementById('btn-upload'),
    fileInput: document.getElementById('file-input'),
    btnGesture: document.getElementById('btn-gesture'),
    btnToggleSpark: document.getElementById('btn-toggle-spark'),
    btnSettings: document.getElementById('btn-settings'),
    btnDownload: document.getElementById('btn-download'),
    settingsPanel: document.getElementById('settings-panel'),
    mobileCameraOptions: document.getElementById('mobile-camera-options'),
    desktopFlightAnchor: document.getElementById('desktop-flight-anchor'),
    desktopScatterAnchor: document.getElementById('desktop-scatter-anchor'),
    flightPresetItem: document.getElementById('flight-preset-item'),
    scatterEffectItem: document.getElementById('scatter-effect-item'),
    settingMaxParticles: document.getElementById('setting-max-particles'),
    settingCropFactor: document.getElementById('setting-crop-factor'),
    settingCropFactorVal: document.getElementById('setting-crop-factor-val'),
    settingMinOpacity: document.getElementById('setting-min-opacity'),
    settingMinOpacityVal: document.getElementById('setting-min-opacity-val'),
    settingPointSize: document.getElementById('setting-point-size'),
    settingPointSizeVal: document.getElementById('setting-point-size-val'),
    settingPointDensity: document.getElementById('setting-point-density'),
    settingPointDensityVal: document.getElementById('setting-point-density-val'),
    settingParticleBrightness: document.getElementById('setting-particle-brightness'),
    settingParticleBrightnessVal: document.getElementById('setting-particle-brightness-val'),
    settingParticleSoftness: document.getElementById('setting-particle-softness'),
    settingParticleSoftnessVal: document.getElementById('setting-particle-softness-val'),
    settingParticleOpacity: document.getElementById('setting-particle-opacity'),
    settingParticleOpacityVal: document.getElementById('setting-particle-opacity-val'),
    settingSplatScale: document.getElementById('setting-splat-scale'),
    settingSplatScaleVal: document.getElementById('setting-splat-scale-val'),
    settingScatterEffect: document.getElementById('setting-scatter-effect'),

    loadingOverlay: document.getElementById('loading-overlay'),
    loadingText: document.getElementById('loading-text'),
    loadingBar: document.getElementById('loading-bar'),
    statsPanel: document.getElementById('stats-panel'),
    statParticles: document.getElementById('stat-particles'),
    statFps: document.getElementById('stat-fps'),
    statProgress: document.getElementById('stat-progress'),
    progressControl: document.getElementById('progress-control'),
    progressSlider: document.getElementById('progress-slider'),
    progressValue: document.getElementById('progress-value'),
    webcamContainer: document.getElementById('webcam-container'),
    webcamVideo: document.getElementById('webcam-video'),
    webcamDot: document.getElementById('webcam-dot'),
    gestureIcon: document.getElementById('gesture-icon'),
    gestureText: document.getElementById('gesture-text'),
    gestureStatus: document.getElementById('gesture-status'),
    welcomeHint: document.getElementById('welcome-hint'),
    landingUrlInput: document.getElementById('landing-url-input'),
    landingBtnLoad: document.getElementById('landing-btn-load'),
    toastContainer: document.getElementById('toast-container'),
    
    // Camera Path elements
    btnCameraMode: document.getElementById('btn-camera-mode'),
    cameraPathPanel: document.getElementById('camera-path-panel'),
    selectPresetFlight: document.getElementById('select-preset-flight'),
    keyframeList: document.getElementById('keyframe-list'),
    customKeyframeActions: document.getElementById('custom-keyframe-actions'),
    btnAddKeyframe: document.getElementById('btn-add-keyframe'),
    btnClearKeyframes: document.getElementById('btn-clear-keyframes'),
    btnPreviewPath: document.getElementById('btn-preview-path'),
    btnHeaderPreview: document.getElementById('btn-header-preview'),
    previewControls: document.getElementById('preview-controls'),
    btnPreviewToggleRenderer: document.getElementById('btn-preview-toggle-renderer'),
    btnPreviewStop: document.getElementById('btn-preview-stop'),
    btnPreviewExport: document.getElementById('btn-preview-export'),
    recordingControls: document.getElementById('recording-controls'),
    btnRecordingToggleRenderer: document.getElementById('btn-recording-toggle-renderer'),
    btnRecordingStop: document.getElementById('btn-recording-stop'),
    recordingIndicator: document.getElementById('recording-indicator'),
    btnExportVideo: document.getElementById('btn-export-video'),
    btnFlipX: document.getElementById('btn-flip-x'),
    btnPlayScatter: document.getElementById('btn-play-scatter'),
    btnLang: document.getElementById('btn-lang'),
    btnHome: document.getElementById('btn-home'),
    keyframeCount: document.getElementById('keyframe-count'),
  };
}
// ============================================================
// Three.js Setup
// ============================================================
function initThreeJS() {
  // Scene
  state.scene = new THREE.Scene();
  // Camera
  state.camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.01,
    100
  );
  // Default camera position: set at a normal viewing distance (1x radius zoom)
  state.camera.position.set(0, 0.15, 1.0);
  // Renderer (antialias: false is highly recommended for Spark 2.0 performance)
  state.renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: true,
    powerPreference: 'high-performance',
  });
  state.renderer.setSize(window.innerWidth, window.innerHeight);
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_INTERACTIVE_PIXEL_RATIO));
  state.renderer.setClearColor(0x06060f, 1);
  dom.container.appendChild(state.renderer.domElement);
  // Controls
  state.controls = new OrbitControls(state.camera, state.renderer.domElement);
  state.controls.enableDamping = true;
  state.controls.dampingFactor = 0.05;
  state.controls.enablePan = true;
  state.controls.enableZoom = true;
  state.controls.minDistance = 0.1; // Allows zooming in extremely close
  state.controls.maxDistance = 20;
  state.controls.target.set(0, 0, 0);
  // Clock
  state.clock = new THREE.Clock();
  // Subtle ambient light (for potential future mesh additions)
  const ambientLight = new THREE.AmbientLight(0x404060, 0.5);
  state.scene.add(ambientLight);
  // Particle System
  state.particleSystem = new ParticleSystem();
  // Landing galaxy background effect
  state.landingBg = new LandingBackground(state.scene);
  
  // Track mouse coordinates for depth parallax effect on homepage
  window.addEventListener('mousemove', (e) => {
    state.mouseTarget.x = (e.clientX / window.innerWidth) * 2 - 1;
    state.mouseTarget.y = -(e.clientY / window.innerHeight) * 2 + 1;
  });
  
  // Handle resize
  window.addEventListener('resize', onResize);
}
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  state.camera.aspect = w / h;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(w, h);
  
  if (state.particleSystem) {
    state.particleSystem.setViewportSize(w, h);
  }
  syncResponsiveControlLayout();
}

function syncResponsiveControlLayout() {
  if (!dom.mobileCameraOptions || !dom.flightPresetItem || !dom.scatterEffectItem) return;

  if (isMobileViewport()) {
    dom.mobileCameraOptions.append(dom.flightPresetItem, dom.scatterEffectItem);
  } else {
    dom.desktopFlightAnchor.after(dom.flightPresetItem);
    dom.desktopScatterAnchor.after(dom.scatterEffectItem);
  }
}

function syncModelRendererVisibility() {
  if (!state.isModelLoaded) return;
  const showParticles = state.splatInterpolation < (1.0 - RENDERER_VISIBILITY_EPSILON);
  const showSpark = state.splatInterpolation > RENDERER_VISIBILITY_EPSILON;

  if (
    state.rendererVisibility.particles === showParticles &&
    state.rendererVisibility.spark === showSpark
  ) return;
  state.rendererVisibility.particles = showParticles;
  state.rendererVisibility.spark = showSpark;
  
  if (state.particleSystem && state.particleSystem.pivot) {
    state.particleSystem.pivot.visible = showParticles;
  }
  if (state.splatPivot) {
    state.splatPivot.visible = showSpark;
  }
  if (state.splatMesh) {
    state.splatMesh.visible = showSpark;
  }
  if (state.sparkRenderer) {
    state.sparkRenderer.visible = showSpark;
  }
}
// ============================================================
// Internationalization (i18n) translation system
// ============================================================
const translations = {
  zh: {
    // Toolbar
    'url-placeholder': '粘贴 Remy3D 或 Kiri Engine 分享链接...',
    'btn-load-title': '从链接加载模型',
    'btn-load-text': '加载',
    'btn-upload-title': '上传本地 PLY 文件',
    'btn-upload-text': '上传 PLY',
    'btn-download-title': '下载当前的 PLY/Splat 文件',
    'btn-download-text': '下载',
    'btn-spark-title': '切换 Spark 2.0 3DGS 模式',
    'btn-spark-text': '3D实景',
    'btn-pointcloud-text': '粒子模式',
    'btn-gesture-title': '启用/禁用手势控制',
    'btn-gesture-text': '手势控制',
    'btn-camera-title': '打开镜头路径录制/导出模式',
    'btn-camera-text': '镜头运镜',
    'btn-settings-title': '打开渲染与过滤设置面板',
    'btn-settings-text': '渲染设置',
    'btn-guide-title': '打开使用手册',
    'btn-guide-text': '使用指南',
    'btn-lang-title': 'Switch to English / 切换至英文',
    'btn-lang-text': '中/EN',
    // Panels
    'camera-panel-title': '镜头运镜导出',
    'camera-start-hint': '滑动可调整运镜的初始位置',
    'camera-panel-subtitle': '请自行调整视角，初始位置将作为内置运镜的首帧。预览时可在粒子模式与 3D实景之间切换，效果将完整录制。',
    'preset-flight-label': '内置运镜预设',
    'preset-none': '-- 自定义关键帧请选择 --',
    'preset-orbit360': '1. 环绕 360 度 (水平)',
    'preset-verticalLoop': '2. 垂直俯仰环绕',
    'preset-figure8': '3. 8字形无限循环',
    'preset-spiralHelix': '4. 螺旋上升缩放',
    'preset-sinusoidWave': '5. 正弦波高度起伏',
    'preset-panZoomScan': '6. 细节平移与缩放扫描',
    'preset-dollyZoom': '7. 电影级希区柯克滑动变焦',
    'preset-butterfly': '8. 球面蝴蝶形扫拂',
    'preset-pendulum': '9. 钟摆摇摆弧线',
    'preset-heroSweep': '10. 低角度英雄扫拂',
    'preset-macroRing': '11. 特写微距环绕',
    'preset-zenithSpiral': '12. 极点偏航极圈螺旋',
    'preset-rhombic': '13. 菱形钻石轨迹',
    'preset-heart': '14. 3D 心形循环飞行',
    'preset-turbulence': '15. 乱噪波流体飞行',
    'btn-add-keyframe': '添加关键帧',
    'btn-clear-keyframes': '清空',
    'btn-preview-path': '预览',
    'btn-export-video': '导出视频',
    // Rendering Settings
    'settings-title': '渲染设置',
    'label-max-particles': '最大粒子数 (点云模式)',
    'opt-particles-50k': '50,000 (极速)',
    'opt-particles-150k': '150,000 (推荐)',
    'opt-particles-300k': '300,000 (高精)',
    'opt-particles-500k': '500,000 (极精)',
    'label-crop-factor': '过滤背景范围 (裁剪)',
    'label-min-opacity': '最小不透明度 (3DGS模式)',
    'label-point-size': '点云粒子大小',
    'label-point-density': '点云粒子密度',
    'label-particle-brightness': '点云粒子亮度',
    'label-particle-softness': '点云粒子羽化度',
    'label-particle-opacity': '点云粒子透明度',
    'label-splat-scale': '高斯泼溅大小 (3DGS模式)',
    'label-scatter-effect': '粒子分散/重组效果',
    'effect-none': '无需粒子特效',

    // Scatter Effects Options
    'effect-0': '1. 原始无序粒子炸裂',
    'effect-1': '2. 角落对角线波前扫拂',
    'effect-3': '3. 随机区块渐隐消散',
    'effect-8': '4. 由上而下瀑布流消散',
    'effect-11': '5. 双螺旋结构向上攀升',
    'effect-16': '6. 粒子逐层打印重组',
    'effect-13': '7. 分形几何轨道重组',
    'effect-14': '8. 风吹飞砂由后向前扫拂',
    'effect-17': '9. 雨点由天而降重组',
    // Stats & Progress
    'stat-label-particles': '当前粒子数',
    'stat-label-fps': '当前帧率',
    'progress-label-scatter': '粒子消散 / 聚合进度',
    'btn-flip-vertical': '垂直翻转模型',
    // Webcam & Gesture
    'webcam-live': '本地离线识别',
    'gesture-init': '正在初始化 AI 模型...',
    'gesture-no-hand': '未检测到手部',
    'gesture-fist': '攥拳 (0% 粒子重组)',
    'gesture-palm': '张手 (100% 粒子消散)',
    'gesture-victory': '剪刀手 (切换3DGS/点云, 需保持0.7秒)',
    'gesture-pointing': '双手拳头 (缩放模型)',
    'gesture-ok': '食指指向 (遥控相机旋转)',
    'guide-palm': '🖐️ 张开手掌：粒子消散',
    'guide-fist': '✊ 握拳：粒子聚集',
    'guide-victory': '✌️ 剪刀手：切换模式',
    'guide-zoom': '✊✊ 双拳缩放：缩放模型',
    'guide-pointing': '☝️ 食指：控制模型视角',
    // Remy Intro
    'remy-intro-title': '✨ 关于 Remy',
    'remy-visit-link': '→前往 Remy 官网',
    'remy-intro-content': '照片视频很美好，但 3D 影像更显珍贵。Remy 是一款 3D 空间记录 App，让美好记忆场景可以保存并沉浸式体验。本网页使用 Vibe Coding 制作，你可以导入 Remy 已生成的 3D 影像，体验自定义运镜、发光粒子特效、手势控制等玩法，让 3D 影像变成更好玩的数字载体，祝你玩的开心！',
    // Welcome Hint & Loading
    'welcome-title': '✨ Remy 自定义特效运镜工具',
    'welcome-desc': '在下方输入框中粘贴 <a href="https://www.remy3d.cn/" target="_blank" rel="noopener" class="desc-link">Remy3D</a> 或 <a href="https://www.kiriengine.app/" target="_blank" rel="noopener" class="desc-link">Kiri Engine</a> 分享链接，即可开始您的 3D 粒子和 3DGS 实景体验。',
    'landing-url-placeholder': '粘贴 Remy3D 或 Kiri Engine 分享链接...',
    'loading-init': '加载中...',
    'loading-downloading': '正在获取 3DGS 数据，请稍候...',
    'loading-parsing': '正在读取 PLY 点云数据，请稍候...',
    'loading-processing': '正在构建 GPU 渲染管线...',
    'loading-spark': '正在加载并初始化 Spark 2.0 3DGS 写实渲染引擎...',
    // Alerts/Toasts
    'enter-valid-url': '请输入 Remy3D 或 Kiri Engine 分享链接',
    'enter-valid-url-2': '请输入有效的 Remy3D 或 Kiri Engine 分享链接',
    'failed-parse-ply': '解析 PLY 文件失败: ',
    'failed-load-spark': '加载 Spark 2.0 引擎失败: ',
    'loaded-success-prefix': '',
    'loaded-success-suffix': ' 元素已加载',
    'spark-load-failed': 'Spark 载入失败: ',
    'gesture-tracking-active': '✋ 手势控制已激活！张开/合拢手掌可控制消散，双手拳头微调模型缩放，比出“✌️”手势并保持0.7秒可切换模式',
    'flight-preview-finished': '镜头运镜预览已结束',
    'gesture-switched-spark': '手势触发：已切换至 3D实景',
    'gesture-switched-cloud': '手势触发：已切换至粒子模式',
    'spark-mode-enabled': '已切换至 3D实景',
    'point-cloud-enabled': '已切换至粒子模式',
    'load-model-first': '请先加载一个 3D 模型',
    'camera-path-active': '镜头运镜模式已开启：调整视角并点击“添加关键帧”！',
    'max-keyframes-allowed': '最多只能录制 5 个关键帧',
    'keyframe-recorded-prefix': '关键帧 ',
    'keyframe-recorded-suffix': ' 已成功录制！',
    'keyframes-cleared': '所有关键帧已清空',
    'keyframe-removed': '已删除该关键帧',
    'flight-preview-stopped': '运镜预览已停止',
    'looping-preset': '正在循环播放内置运镜预设: ',
    'previewing-camera-flight': '正在预览镜头自定义轨迹飞行...',
    'video-exported-success': 'MP4 运镜视频成功导出并已开始下载！',
    'recording-camera-flight-toast': '正在后台进行离屏 1080p 超清运镜录制中，请稍候...',
    'converting-splat-ply': '正在将内存中的 Splat 数据转换并压缩为 PLY 格式...',
    'download-success-prefix': '下载成功: ',
    'download-success-suffix': '',
    'export-failed-download-raw': 'Splat 到 PLY 转换失败，已自动为您下载原始 Splat 文件。',
    'drop-ply-only': '请拖放有效的 .ply 格式文件',
    'model-inverted': '模型方向已垂直翻转 (纠正上下颠倒)',
    'model-restored': '已恢复模型的默认方向',
    'reprocessing-settings': '正在以新的参数重新解析并过滤粒子...',
    'error-applying-settings': '应用设置失败: ',
    'settings-saved-load-first': '设置已保存，将在加载下一个模型时生效。',
    // Dynamic loading steps
    'extracting-url': '正在解析模型文件链接...',
    'parsing-share': '正在读取分享页面...',
    'downloading-prefix': '正在下载: ',
    'downloading-suffix': '',
    'loading-spark-engine': '正在载入 Spark 2.0 渲染引擎...',
    'parsing-model-data': '正在解析模型点云数据...',
    'creating-particles': '正在生成 GPU 粒子云几何体...',
    'loading-spark-3dgs': '正在加载写实 3DGS 实景...',
    'done': '完成！',
    'spark-load-prefix': 'Spark 实景引擎加载中: ',
    'spark-load-suffix': '',
    'reapplying-settings': '正在重新应用设置...',
    'configuring-render': '正在配置 1080p 超清离屏渲染管线...'
  },
  en: {
    // Toolbar
    'url-placeholder': 'Paste Remy3D or Kiri Engine share URL...',
    'btn-load-title': 'Load model from URL',
    'btn-load-text': 'Load',
    'btn-upload-title': 'Upload local PLY file',
    'btn-upload-text': 'Upload PLY',
    'btn-download-title': 'Download current PLY/Splat file',
    'btn-download-text': 'Download',
    'btn-spark-title': 'Toggle Spark 2.0 3DGS mode',
    'btn-spark-text': '3D Reality',
    'btn-pointcloud-text': 'Particle Mode',
    'btn-gesture-title': 'Toggle hand gesture control',
    'btn-gesture-text': 'Gesture',
    'btn-camera-title': 'Open camera path export mode',
    'btn-camera-text': 'Camera Path',
    'btn-settings-title': 'Open rendering & filtering settings',
    'btn-settings-text': 'Settings',
    'btn-guide-title': 'Open user guide',
    'btn-guide-text': 'Guide',
    'btn-lang-title': 'Switch to Chinese / 切换至中文',
    'btn-lang-text': '中/EN',
    // Panels
    'camera-panel-title': 'Camera Path Export',
    'camera-start-hint': 'Swipe to adjust the initial camera position',
    'camera-panel-subtitle': 'Please adjust your view; the initial position will serve as the first frame of the built-in flight preset. Click export video; during export, you can toggle point cloud mode and play particle effects, which will be fully recorded.',
    'preset-flight-label': 'Flight Path Preset',
    'preset-none': '-- Custom Keyframes - Please Select --',
    'preset-orbit360': '1. Orbit 360 (Horizontal)',
    'preset-verticalLoop': '2. Vertical Pitch Loop',
    'preset-figure8': '3. Figure-8 Infinity Loop',
    'preset-spiralHelix': '4. Spiral Helix Zoom',
    'preset-sinusoidWave': '5. Sinusoid Altitude Wave',
    'preset-panZoomScan': '6. Detail Pan & Zoom Scan',
    'preset-dollyZoom': '7. Cinematic Dolly Zoom',
    'preset-butterfly': '8. Spherical Butterfly Sweep',
    'preset-pendulum': '9. Pendulum Swing Arc',
    'preset-heroSweep': '10. Low-Angle Hero Sweep',
    'preset-macroRing': '11. Close-up Macro Orbit',
    'preset-zenithSpiral': '12. Zenith Polar Spiral',
    'preset-rhombic': '13. Rhombic Diamond Path',
    'preset-heart': '14. 3D Cardiomorphic Loop',
    'preset-turbulence': '15. Turbulence Noise Flight',
    'btn-add-keyframe': 'Add Keyframe',
    'btn-clear-keyframes': 'Clear',
    'btn-preview-path': 'Preview',
    'btn-export-video': 'Export Video',
    // Rendering Settings
    'settings-title': 'Rendering Settings',
    'label-max-particles': 'Max Particles (Particle Cloud)',
    'opt-particles-50k': '50,000 (Fastest)',
    'opt-particles-150k': '150,000 (Recommended)',
    'opt-particles-300k': '300,000 (High Detail)',
    'opt-particles-500k': '500,000 (Maximum)',
    'label-crop-factor': 'Filter Background (Crop)',
    'label-min-opacity': 'Min Opacity (3DGS)',
    'label-point-size': 'Base Particle Size',
    'label-point-density': 'Point Cloud Density',
    'label-particle-brightness': 'Particle Brightness',
    'label-particle-softness': 'Particle Softness',
    'label-particle-opacity': 'Particle Opacity',
    'label-splat-scale': 'Splat Scale (3DGS)',
    'label-scatter-effect': 'Scatter Effect',
    'effect-none': 'No particle effects',

    // Scatter Effects Options
    'effect-0': '1. Original Explosion',
    'effect-1': '2. Diagonal Wavefront Sweep',
    'effect-3': '3. Thanos Snap Dissolve',
    'effect-8': '4. Waterfall Downward Flow',
    'effect-11': '5. Double Helix Upward',
    'effect-16': '6. Hologram 3D Printer',
    'effect-13': '7. Fractal Julia Orbit',
    'effect-14': '8. Wind Snap Sweep',
    'effect-17': '9. Raindrop Falling Assembly',
    // Stats & Progress
    'stat-label-particles': 'Particles',
    'stat-label-fps': 'FPS',
    'progress-label-scatter': 'Scatter / Gather',
    'btn-flip-vertical': 'Flip Vertically',
    // Webcam & Gesture
    'webcam-live': 'Local Offline Tracking',
    'gesture-init': 'Initializing AI...',
    'gesture-no-hand': 'No Hand Detected',
    'gesture-fist': 'Fist (0% Assembled)',
    'gesture-palm': 'Palm (100% Scattered)',
    'gesture-victory': 'Victory (Toggle Mode, hold 0.7s)',
    'gesture-pointing': 'Two Fists (Scale)',
    'gesture-ok': 'Pointing Up (Camera Control)',
    'guide-palm': '🖐️ Open Palm: Dissipate',
    'guide-fist': '✊ Closed Fist: Assemble',
    'guide-victory': '✌️ Victory: Toggle Mode',
    'guide-zoom': '✊✊ Two Fists: Scale Model',
    'guide-pointing': '☝️ Index Finger: Rotate View',
    // Remy Intro
    'remy-intro-title': '✨ About Remy',
    'remy-visit-link': '→ Visit Remy',
    'remy-intro-content': 'Photos and videos are beautiful, but 3D imagery is even more precious. Remy is a 3D spatial capture App that preserves cherished memories for immersive replay. Built using Vibe Coding, this web app lets you import your Remy 3D captures to experiment with custom camera paths, glowing particle effects, and hand gestures. Let\'s make 3D captures a more playful digital medium. Have fun!',
    // Welcome Hint & Loading
    'welcome-title': '✨ Remy Custom Effects & Camera Tool',
    'welcome-desc': 'Paste a <a href="https://www.remy3d.cn/" target="_blank" rel="noopener" class="desc-link">Remy3D</a> or <a href="https://www.kiriengine.app/" target="_blank" rel="noopener" class="desc-link">Kiri Engine</a> share URL below to begin exploring in 3D Point Cloud and Spark 3DGS.',
    'landing-url-placeholder': 'Paste Remy3D or Kiri Engine share URL here...',
    'loading-init': 'Loading...',
    'loading-downloading': 'Downloading 3DGS data, please wait...',
    'loading-parsing': 'Parsing PLY point cloud, please wait...',
    'loading-processing': 'Building GPU pipeline...',
    'loading-spark': 'Loading Spark 2.0 3DGS rendering engine...',
    // Alerts/Toasts
    'enter-valid-url': 'Please enter a Remy3D or Kiri Engine share URL',
    'enter-valid-url-2': 'Please enter a valid Remy3D or Kiri Engine share URL',
    'failed-parse-ply': 'Failed to parse PLY file: ',
    'failed-load-spark': 'Failed to load Spark 2.0 engine: ',
    'loaded-success-prefix': '',
    'loaded-success-suffix': ' elements loaded',
    'spark-load-failed': 'Spark load failed: ',
    'gesture-tracking-active': '✋ Hand tracking active! Open/close hand to morph, two fists to scale model, Victory gesture (hold 0.7s) to toggle mode',
    'flight-preview-finished': 'Flight preview finished',
    'gesture-switched-spark': 'Gesture: Switched to 3D Reality',
    'gesture-switched-cloud': 'Gesture: Switched to Particle Mode',
    'spark-mode-enabled': '3D Reality enabled',
    'point-cloud-enabled': 'Particle Mode enabled',
    'load-model-first': 'Please load a model first',
    'camera-path-active': 'Camera Path Mode active: Adjust view and record keyframes!',
    'max-keyframes-allowed': 'Maximum 5 keyframes allowed',
    'keyframe-recorded-prefix': 'Keyframe ',
    'keyframe-recorded-suffix': ' recorded!',
    'keyframes-cleared': 'All keyframes cleared',
    'keyframe-removed': 'Keyframe removed',
    'flight-preview-stopped': 'Flight preview stopped',
    'looping-preset': 'Looping preset: ',
    'previewing-camera-flight': 'Previewing camera flight path...',
    'video-exported-success': 'Video exported successfully!',
    'recording-camera-flight-toast': 'Recording 1080p MP4 camera flight...',
    'converting-splat-ply': 'Converting splat data to standard PLY format...',
    'download-success-prefix': 'Downloaded ',
    'download-success-suffix': ' successfully',
    'export-failed-download-raw': 'Export failed. Downloading raw splat file instead.',
    'drop-ply-only': 'Please drop a valid .ply file',
    'model-inverted': 'Model inverted vertically',
    'model-restored': 'Model orientation restored',
    'reprocessing-settings': 'Re-processing with new settings...',
    'error-applying-settings': 'Error applying settings: ',
    'settings-saved-load-first': 'Settings saved. Load a model to apply.',
    // Dynamic loading steps
    'extracting-url': 'Extracting model URL...',
    'parsing-share': 'Parsing share page...',
    'downloading-prefix': 'Downloading: ',
    'downloading-suffix': '',
    'loading-spark-engine': 'Loading Spark 2.0 Engine...',
    'parsing-model-data': 'Parsing model data...',
    'creating-particles': 'Creating Particle Cloud...',
    'loading-spark-3dgs': 'Loading Spark 3DGS...',
    'done': 'Done!',
    'spark-load-prefix': 'Spark Load: ',
    'spark-load-suffix': '',
    'reapplying-settings': 'Re-applying settings...',
    'configuring-render': 'Configuring 1080p WebGL render...'
  }
};

function t(key) {
  return translations[state.lang] && translations[state.lang][key] !== undefined
    ? translations[state.lang][key]
    : key;
}

function applyTranslations(lang) {
  const dict = translations[lang];
  if (!dict) return;
  
  // Set HTML lang attribute
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';

  // URL Input
  if (dom.urlInput) dom.urlInput.placeholder = dict['url-placeholder'];

  // Toolbar buttons text and titles
  if (dom.btnLoad) {
    dom.btnLoad.title = dict['btn-load-title'];
    const txt = dom.btnLoad.querySelector('.btn-text');
    if (txt) txt.textContent = dict['btn-load-text'];
  }
  if (dom.btnUpload) {
    dom.btnUpload.title = dict['btn-upload-title'];
    const txt = dom.btnUpload.querySelector('.btn-text');
    if (txt) txt.textContent = dict['btn-upload-text'];
  }
  if (dom.btnDownload) {
    dom.btnDownload.title = dict['btn-download-title'];
    const txt = dom.btnDownload.querySelector('.btn-text');
    if (txt) txt.textContent = dict['btn-download-text'];
  }
  if (dom.btnToggleSpark) {
    dom.btnToggleSpark.title = dict['btn-spark-title'];
  }
  if (dom.btnGesture) {
    dom.btnGesture.title = dict['btn-gesture-title'];
    const txt = dom.btnGesture.querySelector('.btn-text');
    if (txt) txt.textContent = dict['btn-gesture-text'];
  }
  if (dom.btnCameraMode) {
    dom.btnCameraMode.title = dict['btn-camera-title'];
    const txt = dom.btnCameraMode.querySelector('.btn-text');
    if (txt) txt.textContent = dict['btn-camera-text'];
  }
  if (dom.btnSettings) {
    dom.btnSettings.title = dict['btn-settings-title'];
    const txt = dom.btnSettings.querySelector('.btn-text');
    if (txt) txt.textContent = dict['btn-settings-text'];
  }
  
  // Guide link
  const btnGuide = document.querySelector('a[href="guide.html"]');
  if (btnGuide) {
    btnGuide.title = dict['btn-guide-title'];
    const txt = btnGuide.querySelector('.btn-text');
    if (txt) txt.textContent = dict['btn-guide-text'];
  }

  // Language toggle button itself (highlights active span)
  if (dom.btnLang) {
    dom.btnLang.title = dict['btn-lang-title'];
    const zhSpan = dom.btnLang.querySelector('.lang-zh');
    const enSpan = dom.btnLang.querySelector('.lang-en');
    if (zhSpan && enSpan) {
      if (lang === 'zh') {
        zhSpan.classList.add('active-lang');
        enSpan.classList.remove('active-lang');
      } else {
        zhSpan.classList.remove('active-lang');
        enSpan.classList.add('active-lang');
      }
    }
  }

  // Camera Path Panel
  if (dom.cameraPathPanel) {
    const h3 = dom.cameraPathPanel.querySelector('h3');
    if (h3) h3.textContent = dict['camera-panel-title'];
    const p = dom.cameraPathPanel.querySelector('p');
    if (p) {
      p.textContent = isMobileViewport()
        ? (lang === 'zh'
          ? '请调整好视角作为导出视频的首帧，并选择合适的运镜预设或设置关键帧，点击预览或导出视频进行保存。'
          : 'Adjust the view to set the first frame, then choose a camera preset or add keyframes. Tap Preview or Export Video to save it.')
        : dict['camera-panel-subtitle'];
    }
    
    const selectPresetLabel = dom.cameraPathPanel.querySelector('label[for="select-preset-flight"]');
    if (selectPresetLabel) selectPresetLabel.textContent = dict['preset-flight-label'];
    
    if (dom.selectPresetFlight) {
      dom.selectPresetFlight.options[0].textContent = dict['preset-none'];
      dom.selectPresetFlight.options[1].textContent = dict['preset-orbit360'];
      dom.selectPresetFlight.options[2].textContent = dict['preset-verticalLoop'];
      dom.selectPresetFlight.options[3].textContent = dict['preset-figure8'];
      dom.selectPresetFlight.options[4].textContent = dict['preset-spiralHelix'];
      dom.selectPresetFlight.options[5].textContent = dict['preset-sinusoidWave'];
      dom.selectPresetFlight.options[6].textContent = dict['preset-panZoomScan'];
      dom.selectPresetFlight.options[7].textContent = dict['preset-dollyZoom'];
      dom.selectPresetFlight.options[8].textContent = dict['preset-butterfly'];
      dom.selectPresetFlight.options[9].textContent = dict['preset-pendulum'];
      dom.selectPresetFlight.options[10].textContent = dict['preset-heroSweep'];
      dom.selectPresetFlight.options[11].textContent = dict['preset-macroRing'];
      dom.selectPresetFlight.options[12].textContent = dict['preset-zenithSpiral'];
      dom.selectPresetFlight.options[13].textContent = dict['preset-rhombic'];
      dom.selectPresetFlight.options[14].textContent = dict['preset-heart'];
      dom.selectPresetFlight.options[15].textContent = dict['preset-turbulence'];
    }
    
    if (dom.btnAddKeyframe) {
      const label = dom.btnAddKeyframe.querySelector('.keyframe-action-label');
      if (label) label.textContent = dict['btn-add-keyframe'];
    }
    const cameraStartHint = dom.cameraPathPanel.querySelector('.camera-start-hint');
    if (cameraStartHint) cameraStartHint.textContent = dict['camera-start-hint'];
    if (dom.btnClearKeyframes) dom.btnClearKeyframes.textContent = dict['btn-clear-keyframes'];
    if (dom.btnPreviewPath) {
      if (!state.previewActive) {
        dom.btnPreviewPath.textContent = dict['btn-preview-path'];
      } else {
        dom.btnPreviewPath.textContent = lang === 'zh' ? '停止' : 'Stop';
      }
    }
    if (dom.btnHeaderPreview) dom.btnHeaderPreview.textContent = dict['btn-preview-path'];
    if (dom.btnPreviewStop) dom.btnPreviewStop.textContent = lang === 'zh' ? '停止预览' : 'Stop Preview';
    if (dom.btnPreviewExport) dom.btnPreviewExport.textContent = dict['btn-export-video'];
    if (dom.btnRecordingStop) dom.btnRecordingStop.textContent = lang === 'zh' ? '停止导出' : 'Stop Export';
    if (dom.recordingIndicator) dom.recordingIndicator.textContent = lang === 'zh' ? '录制中' : 'Recording';
    if (dom.btnHome) dom.btnHome.textContent = lang === 'zh' ? '首页' : 'Home';
    if (dom.btnExportVideo) dom.btnExportVideo.textContent = dict['btn-export-video'];
  }

  // Settings Panel
  if (dom.settingsPanel) {
    const h3 = dom.settingsPanel.querySelector('h3');
    if (h3) h3.textContent = dict['settings-title'];
    
    const labelParticles = dom.settingsPanel.querySelector('label[for="setting-max-particles"]');
    if (labelParticles) labelParticles.textContent = dict['label-max-particles'];
    const labelCrop = dom.settingsPanel.querySelector('label[for="setting-crop-factor"]');
    if (labelCrop) labelCrop.textContent = dict['label-crop-factor'];
    const labelMinOpacity = dom.settingsPanel.querySelector('label[for="setting-min-opacity"]');
    if (labelMinOpacity) labelMinOpacity.textContent = dict['label-min-opacity'];
    const labelPointSize = dom.settingsPanel.querySelector('label[for="setting-point-size"]');
    if (labelPointSize) labelPointSize.textContent = dict['label-point-size'];
    const labelPointDensity = dom.settingsPanel.querySelector('label[for="setting-point-density"]');
    if (labelPointDensity) labelPointDensity.textContent = dict['label-point-density'];
    const labelParticleBrightness = dom.settingsPanel.querySelector('label[for="setting-particle-brightness"]');
    if (labelParticleBrightness) labelParticleBrightness.textContent = dict['label-particle-brightness'];
    const labelParticleSoftness = dom.settingsPanel.querySelector('label[for="setting-particle-softness"]');
    if (labelParticleSoftness) labelParticleSoftness.textContent = dict['label-particle-softness'];
    const labelParticleOpacity = dom.settingsPanel.querySelector('label[for="setting-particle-opacity"]');
    if (labelParticleOpacity) labelParticleOpacity.textContent = dict['label-particle-opacity'];
    const labelSplatScale = dom.settingsPanel.querySelector('label[for="setting-splat-scale"]');
    if (labelSplatScale) labelSplatScale.textContent = dict['label-splat-scale'];
    const labelScatter = dom.scatterEffectItem?.querySelector('label[for="setting-scatter-effect"]');
    if (labelScatter) labelScatter.textContent = dict['label-scatter-effect'];

    const mobileTags = document.querySelectorAll('.mobile-setting-tag');
    const tagLabels = lang === 'zh'
      ? ['裁剪背景', '粒子大小', '粒子亮度', '粒子密度']
      : ['Crop Background', 'Particle Size', 'Particle Light', 'Particle Density'];
    mobileTags.forEach((tag, index) => {
      tag.textContent = tagLabels[index];
    });
    
    if (dom.settingMaxParticles) {
      dom.settingMaxParticles.options[0].textContent = dict['opt-particles-50k'];
      dom.settingMaxParticles.options[1].textContent = dict['opt-particles-150k'];
      dom.settingMaxParticles.options[2].textContent = dict['opt-particles-300k'];
      dom.settingMaxParticles.options[3].textContent = dict['opt-particles-500k'];
    }

    if (dom.settingScatterEffect) {
      for (let i = 0; i < dom.settingScatterEffect.options.length; i++) {
        const opt = dom.settingScatterEffect.options[i];
        const val = opt.value;
        if (dict[`effect-${val}`]) {
          opt.textContent = dict[`effect-${val}`];
        }
      }
    }
  }

  // Stats Panel
  if (dom.statsPanel) {
    dom.statsPanel.querySelectorAll('.stat-row').forEach(row => {
      const label = row.querySelector('.stat-label');
      if (label) {
        if (label.textContent.includes('Particles') || label.textContent.includes('当前粒子数')) {
          label.textContent = dict['stat-label-particles'];
        } else if (label.textContent.includes('FPS') || label.textContent.includes('当前帧率')) {
          label.textContent = dict['stat-label-fps'];
        }
      }
    });
  }

  // Progress Control
  if (dom.progressControl) {
    const labelSpan = dom.progressControl.querySelector('.progress-label span:first-child');
    if (labelSpan) labelSpan.textContent = dict['progress-label-scatter'];
    if (dom.btnFlipX) {
      const txt = dom.btnFlipX.querySelector('.btn-text');
      if (txt) txt.textContent = dict['btn-flip-vertical'];
    }
  }

  // Welcome Hint
  if (dom.welcomeHint) {
    const h2 = dom.welcomeHint.querySelector('h2');
    if (h2) h2.textContent = dict['welcome-title'];
    const p = dom.welcomeHint.querySelector('p');
    if (p) p.innerHTML = dict['welcome-desc'];
    
    // Translate landing search/dialog inputs
    const landingInput = document.getElementById('landing-url-input');
    if (landingInput) landingInput.placeholder = dict['landing-url-placeholder'];
    const landingBtnText = document.querySelector('#landing-btn-load .btn-text');
    if (landingBtnText) landingBtnText.textContent = dict['btn-load-text'];
  }

  // Webcam dot text
  if (dom.webcamDot && dom.webcamDot.nextSibling) {
    dom.webcamDot.nextSibling.textContent = ' ' + dict['webcam-live'];
  }
  
  // Translate gesture guide items
  const guidePalm = document.getElementById('guide-palm');
  if (guidePalm) guidePalm.textContent = dict['guide-palm'];
  const guideFist = document.getElementById('guide-fist');
  if (guideFist) guideFist.textContent = dict['guide-fist'];
  const guideVictory = document.getElementById('guide-victory');
  if (guideVictory) guideVictory.textContent = dict['guide-victory'];
  const guideZoom = document.getElementById('guide-zoom');
  if (guideZoom) guideZoom.textContent = dict['guide-zoom'];
  const guidePointing = document.getElementById('guide-pointing');
  if (guidePointing) guidePointing.textContent = dict['guide-pointing'];
  
  // Translate Remy Intro panel
  const remyTitle = document.getElementById('remy-intro-title');
  if (remyTitle) remyTitle.textContent = dict['remy-intro-title'];
  const remyVisitLink = document.getElementById('remy-visit-link');
  if (remyVisitLink) remyVisitLink.textContent = dict['remy-visit-link'];
  const remyContent = document.getElementById('remy-intro-content');
  if (remyContent) remyContent.textContent = dict['remy-intro-content'];
  
  // Update toggle button text dynamically (Spark 3DGS vs Point Cloud)
  updateRendererUI();
  
  // Update play/reverse button text based on language and state
  if (typeof updatePlayButtonUI === 'function') {
    updatePlayButtonUI();
  }
}
// ============================================================
// Loading UI
// ============================================================
function showLoading(text = 'Loading...') {
  dom.loadingOverlay.classList.add('visible');
  let translatedText = text;
  const dict = translations[state.lang];
  if (dict) {
    if (text === 'Loading...') {
      translatedText = dict['loading-init'];
    } else if (text === 'Extracting model URL...') {
      translatedText = dict['extracting-url'];
    } else if (text === 'Configuring 1080p WebGL render...') {
      translatedText = dict['configuring-render'];
    } else if (text === 'Re-applying settings...') {
      translatedText = dict['reapplying-settings'];
    } else if (text.startsWith('Loading: ')) {
      translatedText = dict['loading-parsing'] + ' ' + text.replace('Loading: ', '');
    }
  }
  dom.loadingText.textContent = translatedText;
  dom.loadingBar.style.width = '0%';
}
function updateLoadingProgress(progress, text) {
  dom.loadingBar.style.width = `${Math.round(progress * 100)}%`;
  if (text) {
    let translatedText = text;
    const dict = translations[state.lang];
    if (dict) {
      if (text === 'Parsing share page...') {
        translatedText = dict['parsing-share'];
      } else if (text === 'Loading Spark 2.0 Engine...') {
        translatedText = dict['loading-spark-engine'];
      } else if (text === 'Parsing model data...') {
        translatedText = dict['parsing-model-data'];
      } else if (text === 'Creating Particle Cloud...') {
        translatedText = dict['creating-particles'];
      } else if (text === 'Loading Spark 3DGS...') {
        translatedText = dict['loading-spark-3dgs'];
      } else if (text === 'Done!') {
        translatedText = dict['done'];
      } else if (text.startsWith('Downloading: ')) {
        const fileAndPercent = text.replace('Downloading: ', '');
        translatedText = dict['downloading-prefix'] + fileAndPercent + dict['downloading-suffix'];
      } else if (text.startsWith('Parsing: ')) {
        translatedText = dict['parsing-model-data'] + ' ' + text.replace('Parsing: ', '');
      } else if (text.startsWith('Spark Load: ')) {
        translatedText = dict['spark-load-prefix'] + text.replace('Spark Load: ', '') + dict['spark-load-suffix'];
      }
    }
    dom.loadingText.textContent = translatedText;
  }
}
function hideLoading() {
  dom.loadingOverlay.classList.remove('visible');
}
// ============================================================
// Toast Notifications
// ============================================================
function showToast(message, type = 'info', duration = 4000) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  // Resolve localized text dynamically
  let translatedMessage = message;
  const dict = translations[state.lang];
  if (dict) {
    if (dict[message]) {
      translatedMessage = dict[message];
    } else {
      // Dynamic patterns matching
      if (message.startsWith('Failed to parse PLY file: ')) {
        translatedMessage = dict['failed-parse-ply'] + message.replace('Failed to parse PLY file: ', '');
      } else if (message.startsWith('Failed to parse PLY: ')) {
        translatedMessage = dict['failed-parse-ply'] + message.replace('Failed to parse PLY: ', '');
      } else if (message.startsWith('Failed to load Spark 2.0 engine: ')) {
        translatedMessage = dict['failed-load-spark'] + message.replace('Failed to load Spark 2.0 engine: ', '');
      } else if (message.startsWith('Spark load failed: ')) {
        translatedMessage = dict['spark-load-failed'] + message.replace('Spark load failed: ', '');
      } else if (message.startsWith('Keyframe ') && message.endsWith(' recorded!')) {
        const num = message.replace('Keyframe ', '').replace(' recorded!', '');
        translatedMessage = dict['keyframe-recorded-prefix'] + num + dict['keyframe-recorded-suffix'];
      } else if (message.startsWith('Looping preset: ')) {
        translatedMessage = dict['looping-preset'] + message.replace('Looping preset: ', '');
      } else if (message.includes('elements loaded') && message.includes('—')) {
        const parts = message.split('—');
        const num = parts[1].replace('elements loaded', '').trim();
        translatedMessage = parts[0] + '— ' + num + dict['loaded-success-suffix'];
      } else if (message.startsWith('Downloaded ') && message.endsWith(' successfully')) {
        const file = message.replace('Downloaded ', '').replace(' successfully', '');
        translatedMessage = dict['download-success-prefix'] + file + dict['download-success-suffix'];
      } else if (message.startsWith('Error applying settings: ')) {
        translatedMessage = dict['error-applying-settings'] + message.replace('Error applying settings: ', '');
      }
    }
  }

  toast.textContent = translatedMessage;
  dom.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}
// ============================================================
// Model Loading
// ============================================================
/**
 * Load model from Remy3D URL.
 */
async function loadFromUrl() {
  const url = dom.urlInput.value.trim();
  if (!url) {
    showToast('Please enter a Remy3D or Kiri Engine share URL', 'error');
    return;
  }
  if (!url.includes('remy3d') && !url.includes('remy') && !url.includes('kiriengine')) {
    showToast('Please enter a valid Remy3D or Kiri Engine share URL', 'error');
    return;
  }
  showLoading('Extracting model URL...');
  try {
    // Step 1: Extract PLY/Splat URL from the share page
    updateLoadingProgress(0.1, 'Parsing share page...');
    const result = await extractPLYFromUrl(url);
    const { plyUrl, pcdUrl, splatUrl, name, initialCameraPosition } = result;
    state.initialCameraPosition = initialCameraPosition || null;
    if (!plyUrl && !pcdUrl && !splatUrl) {
      throw new Error('No 3D model file URL found');
    }
    // Step 2: Download the file (try 3DGS.splat -> 3DGS.ply -> pcd.ply)
    updateLoadingProgress(0.2, `Downloading: ${name}...`);
    let buffer = null;
    const urlsToTry = [splatUrl, plyUrl, pcdUrl].filter(Boolean);
    for (const tryUrl of urlsToTry) {
      try {
        buffer = await downloadPLY(tryUrl, (p) => {
          updateLoadingProgress(0.2 + p * 0.5, `Downloading: ${Math.round(p * 100)}%`);
        });
        break; // Success
      } catch (e) {
        console.warn(`Failed to download ${tryUrl.substring(0, 60)}:`, e.message);
        continue;
      }
    }
    if (!buffer) {
      throw new Error('Could not download any PLY file. Try uploading manually.');
    }
    // Step 3: Parse and create particles
    await processBuffer(buffer, name, true);
  } catch (error) {
    hideLoading();
    console.error('Load from URL failed:', error);
    showToast(
      `Loading failed: ${error.message}. Try downloading the PLY file and uploading it directly.`,
      'error',
      6000
    );
  }
}
/**
 * Load model from local file.
 */
async function loadFromFile(file) {
  state.initialCameraPosition = null; // Clear URL camera position
  showLoading(`Loading: ${file.name}`);
  try {
    const buffer = await file.arrayBuffer();
    await processBuffer(buffer, file.name.replace(/\.ply$/i, ''), true);
  } catch (error) {
    hideLoading();
    console.error('Load from file failed:', error);
    showToast(`Failed to parse PLY file: ${error.message}`, 'error');
  }
}
/**
 * Clean up existing 3D objects to prevent memory leaks.
 */
function disposeModel() {
  if (state.splatPivot) {
    state.scene.remove(state.splatPivot);
    state.splatPivot = null;
  }
  if (state.splatMesh) {
    if (typeof state.splatMesh.dispose === 'function') {
      state.splatMesh.dispose();
    }
    state.splatMesh = null;
  }
  if (state.particleSystem) {
    state.particleSystem.dispose();
  }
  state.xFlipped = true;
  state.modelCenter = null;
}
/**
 * Process a PLY buffer: parse and load BOTH particle cloud and Spark 2.0 splats.
 */
async function processBuffer(buffer, name, isFreshLoad = false) {
  // Cache raw buffer for quick reloading on settings changes
  state.lastLoadedBuffer = buffer;
  state.lastLoadedName = name;
  state.modelZoomScale = 1.0;
  state.initialZoomDist = null;
  state.keyframes = [];
  if (state.cameraModeActive) {
    toggleCameraMode();
  } else {
    updateKeyframeUI();
  }
  // Clean up previous loaded model
  disposeModel();
  // 1. Ensure Spark 2.0 Engine is dynamically loaded on demand (prevents slow page loading)
  if (!state.sparkRenderer) {
    updateLoadingProgress(0.72, 'Loading Spark 2.0 Engine...');
    try {
      const { SparkRenderer, SplatMesh } = await import('@sparkjsdev/spark');
      state.sparkRenderer = new SparkRenderer({ renderer: state.renderer });
      state.scene.add(state.sparkRenderer);
      state.SplatMeshClass = SplatMesh;
    } catch (err) {
      console.error('Failed to load Spark 2.0 dynamically:', err);
      showToast(`Failed to load Spark 2.0 engine: ${err.message}`, 'error', 6000);
      return;
    }
  }
  // Always add Spark renderer to scene
  if (state.sparkRenderer && !state.scene.children.includes(state.sparkRenderer)) {
    state.scene.add(state.sparkRenderer);
  }
  // 2. Parse PLY data for Point Cloud
  updateLoadingProgress(0.78, 'Parsing model data...');
  await new Promise(resolve => setTimeout(resolve, 50));
  let data;
  try {
    data = parsePLY(buffer, (p) => {
      updateLoadingProgress(0.78 + p * 0.1, `Parsing: ${Math.round(p * 100)}%`);
    }, {
      maxParticles: state.settings.maxParticles,
      cropOutliers: state.settings.cropOutliers,
      cropFactor: state.settings.cropFactor,
      autoCropFactor: isFreshLoad,
      minOpacity: state.settings.minOpacity
    });
    
    // Dynamically apply recommended crop factor for fresh model loads
    if (isFreshLoad && data && data.recommendedCropFactor !== undefined) {
      const factor = data.recommendedCropFactor;
      state.settings.cropFactor = factor;
      if (factor >= 3.0) {
        state.settings.cropOutliers = false;
      } else {
        state.settings.cropOutliers = true;
      }
      if (dom.settingCropFactor) {
        dom.settingCropFactor.value = factor.toFixed(2);
      }
      if (dom.settingCropFactorVal) {
        dom.settingCropFactorVal.textContent = factor >= 3.0 ? (state.lang === 'zh' ? '不缩放' : 'Off') : factor.toFixed(2) + 'x';
      }
    }
  } catch (err) {
    hideLoading();
    console.error(err);
    showToast(`Failed to parse PLY: ${err.message}`, 'error');
    return;
  }
  // 3. Create Particle System
  updateLoadingProgress(0.88, 'Creating Particle Cloud...');
  const info = state.particleSystem.createFromData(data, state.scene);
  state.particleSystem.setViewportSize(window.innerWidth, window.innerHeight);
  state.particleSystem.setPointSize(state.settings.pointSize);
  state.particleSystem.setDensity(state.settings.pointDensity);
  state.particleSystem.setParticleBrightness(state.settings.particleBrightness);
  state.particleSystem.setParticleSoftness(state.settings.particleSoftness);
  state.particleSystem.setParticleOpacity(state.settings.particleOpacity);
  state.particleSystem.setSplatScale(state.settings.splatScale);
  state.particleSystem.setScatterEffect(state.settings.scatterEffect);
  if (state.particleSystem.pivot) {
    state.particleSystem.pivot.scale.setScalar(state.settings.splatScale);
  }
  
  const rotationX = state.xFlipped ? 0 : Math.PI;
  
  // Initialize the particle system rotation.x according to xFlipped state!
  if (state.particleSystem.points) {
    state.particleSystem.points.rotation.x = rotationX;
  }
  
  const scale = info.scale;
  const center = info.center;
  state.modelScale = scale;
  state.modelCenter = center;
  // 4. Create and align Spark SplatMesh
  updateLoadingProgress(0.92, 'Loading Spark 3DGS...');
  try {
    const currentSplatMesh = new state.SplatMeshClass({
      fileBytes: buffer.slice(0), // 3DGS mode keeps all contents (no cropping)
      onLoad: (mesh) => {
        // Prevent race condition (only load if this is still the active mesh)
        if (state.splatMesh !== currentSplatMesh) return;
        
        // Align Spark SplatMesh position, scale and orientation EXACTLY with Particle System
        mesh.rotation.x = rotationX;
        
        // Align Spark SplatMesh position and scale with Particle System
        mesh.scale.setScalar(scale * state.settings.splatScale);
        if (rotationX === 0) {
          mesh.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
        } else {
          mesh.position.set(-center.x * scale, center.y * scale, center.z * scale);
        }
        
        // Set default opacity based on current interpolation setting
        mesh.opacity = state.splatInterpolation;
        // Add splat mesh to the pivot group (ensuring matching world-space rotation Y direction)
        state.splatPivot = new THREE.Group();
        state.splatPivot.add(mesh);
        state.scene.add(state.splatPivot);
        
        // Update camera position
        if (state.initialCameraPosition) {
          const camPos = new THREE.Vector3(
            state.initialCameraPosition[0],
            -state.initialCameraPosition[1], // Flip Y (since Colmap Y is down, Three.js Y is up)
            state.initialCameraPosition[2]   // Keep Z (no flip to maintain the front view)
          );
          // Apply model center translation offset and scale normalization
          camPos.sub(center).multiplyScalar(scale);
          // Apply model rotation align
          if (rotationX !== 0) {
            camPos.y = -camPos.y;
            camPos.z = -camPos.z;
          }
          state.camera.position.copy(camPos);
          console.log('Using initial camera position from cameras.json (flipped Y):', camPos);
        } else {
          const cropFactor = state.settings.cropOutliers ? state.settings.cropFactor : 1.0;
          const targetDistance = 1.0 / cropFactor;
          state.camera.position.set(0, 0.15 * targetDistance, targetDistance);
        }
        state.controls.target.set(0, 0, 0);
        state.controls.update();
        state.isModelLoaded = true;
        state.rendererVisibility.particles = null;
        state.rendererVisibility.spark = null;
        if (dom.btnDownload) {
          dom.btnDownload.disabled = false;
        }
        // Show stats and UI
        dom.statsPanel.classList.add('visible');
        updateRendererUI();
        syncModelRendererVisibility();
        dom.statParticles.textContent = info.particleCount.toLocaleString();
        dom.welcomeHint.classList.add('hidden');
        document.body.classList.remove('landing-mode');
        updateLoadingProgress(1.0, 'Done!');
        setTimeout(() => {
          hideLoading();
          showToast(`${name} — ${info.particleCount.toLocaleString()} elements loaded`, 'success');
        }, 300);
      },
      onProgress: (event) => {
        if (event.total > 0) {
          updateLoadingProgress(0.92 + (event.loaded / event.total) * 0.07, `Spark Load: ${Math.round((event.loaded / event.total) * 100)}%`);
        }
      }
    });
    state.splatMesh = currentSplatMesh;
  } catch (err) {
    hideLoading();
    console.error(err);
    showToast(`Spark load failed: ${err.message}`, 'error', 6000);
  }
}
// ============================================================
// Gesture Control
// ============================================================
const updateRemyPosition = () => {
  const panel = document.getElementById('remy-intro-panel');
  if (!panel || panel.style.display === 'none') return;
  
  const gap = 10;
  const webcamActive = dom.webcamContainer && !dom.webcamContainer.classList.contains('hidden');
  const progressActive = dom.progressControl && dom.progressControl.classList.contains('visible');
  
  if (webcamActive) {
    // Position above the webcam container using its actual rendered height
    const wcRect = dom.webcamContainer.getBoundingClientRect();
    const viewH = window.innerHeight;
    const wcTop = wcRect.top; // top of webcam container relative to viewport
    panel.style.bottom = (viewH - wcTop + gap) + 'px';
  } else if (progressActive) {
    const pcRect = dom.progressControl.getBoundingClientRect();
    const viewH = window.innerHeight;
    panel.style.bottom = (viewH - pcRect.top + gap) + 'px';
  } else {
    panel.style.bottom = '24px';
  }
};

// Deferred version for use after CSS transitions
const updateRemyPositionDeferred = () => {
  updateRemyPosition();
  // Re-position after CSS transition completes (~450ms)
  setTimeout(updateRemyPosition, 500);
};

const updateGestureHighlight = (activeGesture) => {
  const guideItems = {
    'Open_Palm': document.getElementById('guide-palm'),
    'Closed_Fist': document.getElementById('guide-fist'),
    'Victory': document.getElementById('guide-victory'),
    'Pointing_Up_Two_Hands': document.getElementById('guide-zoom'),
    'Pointing_Up': document.getElementById('guide-pointing')
  };
  
  Object.keys(guideItems).forEach(key => {
    const el = guideItems[key];
    if (el) {
      if (key === activeGesture) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    }
  });
};

async function toggleGestureControl() {
  if (state.isGestureActive) {
    // Deactivate
    state.gestureControl.destroy();
    state.isGestureActive = false;
    if (state.particleSystem) {
      state.particleSystem.setTargetProgress(0.0);
    }
    dom.webcamContainer.classList.add('hidden');
    updateRemyPositionDeferred();
    const gIconSpan = dom.btnGesture.querySelector('.btn-icon-emoji');
    const gTextSpan = dom.btnGesture.querySelector('.btn-text');
    if (gIconSpan) gIconSpan.textContent = '🤚';
    if (gTextSpan) gTextSpan.textContent = state.lang === 'zh' ? ' 手势控制' : ' Gesture';
    else dom.btnGesture.textContent = state.lang === 'zh' ? '🤚 手势控制' : '🤚 Gesture';
    dom.btnGesture.classList.remove('active');
    dom.webcamDot.classList.remove('active');
    if (dom.gestureIcon) dom.gestureIcon.textContent = '👋';
    if (dom.gestureText) dom.gestureText.textContent = state.lang === 'zh' ? '已禁用' : 'Disabled';
    if (dom.gestureStatus) dom.gestureStatus.classList.remove('active');
    updateGestureHighlight('none');
    return;
  }
  // Activate
  state.gestureControl = new GestureControl();
  state.gestureControl.onStatusChange = (status, message) => {
    switch (status) {
      case 'loading':
        showToast(message, 'info', 3000);
        break;
      case 'ready':
        dom.webcamContainer.classList.remove('hidden');
        updateRemyPositionDeferred();
        break;
      case 'active':
        dom.webcamDot.classList.add('active');
        if (dom.gestureStatus) dom.gestureStatus.classList.add('active');
        if (dom.gestureText) dom.gestureText.textContent = state.lang === 'zh' ? '等候手势...' : 'Waiting for hand...';
        showToast('gesture-tracking-active', 'success', 6000);
        updateRemyPositionDeferred();
        
        const actIcon = dom.btnGesture.querySelector('.btn-icon-emoji');
        const actText = dom.btnGesture.querySelector('.btn-text');
        if (actIcon) actIcon.textContent = '🟢';
        if (actText) actText.textContent = state.lang === 'zh' ? ' 运行中' : ' Active';
        break;
      case 'error':
        showToast(message, 'error', 5000);
        break;
    }
  };
  state.gestureControl.onGestureChange = (gesture, confidence) => {
    updateGestureHighlight(gesture);
  };
  state.gestureControl.onRotationChange = (dx, dy) => {
    if (state.controls && state.camera) {
      const camera = state.camera;
      const controls = state.controls;
      
      // Sensitivity: radians of rotation per normalized coordinate delta
      const sensitivity = 3.5;
      
      // 1. Calculate offset vector from camera to controls target
      const offset = new THREE.Vector3().copy(camera.position).sub(controls.target);
      
      // 2. Convert offset vector to spherical coordinates
      const spherical = new THREE.Spherical();
      spherical.setFromVector3(offset);
      
      // 3. Rotate spherical coordinates
      // theta is horizontal rotation, phi is vertical rotation
      spherical.theta -= dx * sensitivity;
      spherical.phi = Math.max(
        controls.minPolarAngle || 0,
        Math.min(controls.maxPolarAngle || Math.PI, spherical.phi + dy * sensitivity)
      );
      
      // 4. Convert back to cartesian offset vector
      offset.setFromSpherical(spherical);
      
      // 5. Update camera position relative to target
      camera.position.copy(controls.target).add(offset);
      
      // 6. Force OrbitControls to synchronize and update
      controls.update();
      
      console.log(`[App] Spherical rotation applied: theta = ${spherical.theta.toFixed(3)}, phi = ${spherical.phi.toFixed(3)}`);
    }
  };
  state.gestureControl.onZoomChange = (dist) => {
    if (dist === null) {
      state.initialZoomDist = null;
    } else {
      if (state.initialZoomDist === null) {
        state.initialZoomDist = dist;
        state.initialZoomScale = state.modelZoomScale;
      } else {
        const ratio = dist / state.initialZoomDist;
        // Clamp overall scale factor between 0.1 and 5.0
        state.modelZoomScale = Math.max(0.1, Math.min(5.0, state.initialZoomScale * ratio));
        
        // Scale both Point Cloud and Spark 3DGS pivots to match EXACTLY
        if (state.particleSystem && state.particleSystem.pivot) {
          state.particleSystem.pivot.scale.setScalar(state.modelZoomScale);
        }
        if (state.splatPivot) {
          state.splatPivot.scale.setScalar(state.modelZoomScale);
        }
        
        // Update UI display text with scale zoom percentage
        const percentage = Math.round(state.modelZoomScale * 100);
        dom.gestureText.textContent = state.lang === 'zh' ? `缩放比例: ${percentage}%` : `Zoom: ${percentage}%`;
      }
    }
  };
  const gIconSpan = dom.btnGesture.querySelector('.btn-icon-emoji');
  const gTextSpan = dom.btnGesture.querySelector('.btn-text');
  if (gIconSpan) gIconSpan.textContent = '⏳';
  if (gTextSpan) gTextSpan.textContent = state.lang === 'zh' ? ' 加载中...' : ' Loading...';
  else dom.btnGesture.textContent = state.lang === 'zh' ? '⏳ 加载中...' : '⏳ Loading...';
  dom.webcamContainer.classList.remove('hidden');
  updateRemyPositionDeferred();
  const success = await state.gestureControl.init(dom.webcamVideo);
  if (success) {
    state.isGestureActive = true;
    state.manualControl = false; // Reset manual control block immediately so gestures take effect!
    if (gIconSpan) gIconSpan.textContent = '🖐️';
    if (gTextSpan) gTextSpan.textContent = state.lang === 'zh' ? ' 手势控制' : ' Gesture';
    else dom.btnGesture.textContent = state.lang === 'zh' ? '🖐️ 手势控制' : '🖐️ Gesture';
    dom.btnGesture.classList.add('active');
  } else {
    if (gIconSpan) gIconSpan.textContent = '🤚';
    if (gTextSpan) gTextSpan.textContent = state.lang === 'zh' ? ' 手势控制' : ' Gesture';
    else dom.btnGesture.textContent = state.lang === 'zh' ? '🤚 手势控制' : '🤚 Gesture';
    dom.webcamContainer.classList.add('hidden');
    updateRemyPositionDeferred();
  }
}
// ============================================================
// Animation Loop
// ============================================================
function animate() {
  requestAnimationFrame(animate);
  const delta = state.clock.getDelta();
  const elapsed = state.clock.getElapsedTime();
  // Pace capture at 60 FPS. When a slower device misses a frame, advance the
  // animation clock by the real elapsed time instead of stretching the clip or
  // rounding partial delays up to whole frames (which can end an orbit early).
  if (state.recordingActive) {
    const now = performance.now();
    const elapsedSinceLastFrame = now - (state.lastRecordFrameTime || 0);
    const frameDuration = 1000 / (state.recordingFps || 60);

    // Accumulate rAF time instead of requiring a callback to be >= 16.67ms.
    // Real 60Hz callbacks are often slightly early (16.2–16.6ms); the old strict
    // comparison skipped them and commonly produced an accidental 30 FPS export.
    state.recordFrameAccumulator = (state.recordFrameAccumulator || 0) + delta * 1000;
    const schedulingTolerance = 1.5;
    if (state.recordFrameAccumulator < frameDuration - schedulingTolerance) {
      return;
    }

    state.recordFrameAccumulator = Math.min(
      frameDuration,
      Math.max(0, state.recordFrameAccumulator - frameDuration)
    );
    state.lastRecordFrameTime = now;
    state.lastRecordRenderDelta = Math.min(elapsedSinceLastFrame / 1000, 0.1);
  }
  // Determine delta and elapsed to pass to updates
  let renderDelta = delta;
  let renderElapsed = elapsed;
  if (state.recordingActive) {
    renderDelta = state.lastRecordRenderDelta || (1 / 60);
    state.virtualElapsedTime = (state.virtualElapsedTime || 0) + renderDelta;
    renderElapsed = state.virtualElapsedTime;
  }
  // FPS counter
  state.frameCount++;
  if (elapsed - state.lastFpsTime >= 1) {
    state.fps = state.frameCount;
    state.frameCount = 0;
    state.lastFpsTime = elapsed;
    if (dom.statFps) dom.statFps.textContent = state.fps;
  }
  // Auto-rotation control (stop rotating only when camera path flight preview mode is active)
  if (state.particleSystem) {
    state.particleSystem.autoRotate = !state.cameraModeActive;
    state.particleSystem.isGestureActive = state.isGestureActive;
  }
  // Gesture detection
  if (state.isGestureActive && state.gestureControl && !state.previewActive && !state.recordingActive) {
    state.gestureControl.detect(performance.now());
    // Apply gesture target to particle system (only if not in manual mode)
    if (!state.manualControl && state.particleSystem) {
      const gestureProgress = state.gestureControl.getTargetProgress();
      // Keep stable 5% buffer zones at both ends. The useful gesture range
      // maps linearly from 5–95% to the full logical particle progress.
      const bufferedProgress = Math.max(0, Math.min(1, (gestureProgress - 0.05) / 0.90));
      state.particleSystem.setTargetProgress(bufferedProgress);
    }
    // Toggle Spark 3DGS mode via ✌️ Victory gesture (state transition trigger with 0.7s hold threshold)
    const currentGesture = state.gestureControl.getGestureInfo().gesture;
    if (currentGesture === 'Victory') {
      if (!state.victoryGestureStartTime) {
        state.victoryGestureStartTime = performance.now();
        state.victoryGestureTriggered = false;
      } else if (!state.victoryGestureTriggered && (performance.now() - state.victoryGestureStartTime > 700)) {
        toggleRendererMode('gesture');
        state.victoryGestureTriggered = true;
      }
    } else {
      state.victoryGestureStartTime = null;
      state.victoryGestureTriggered = false;
    }
    state.lastGesture = currentGesture;
  }
  // Target interpolation based on renderer setting (no hand-open dissipation in Spark mode)
  state.splatInterpolationTarget = (state.settings.renderer === 'spark') ? 1.0 : 0.0;
  const transitionDirection = state.splatInterpolationTarget >= state.splatInterpolation ? 1.0 : -1.0;
  // Interpolate splat transition (0.0 to 1.0)
  // Mobile export briefly renders particles and Spark together during a crossfade.
  // Finish that expensive overlap sooner to protect recorded frame pacing while
  // keeping the normal preview/desktop transition unchanged.
  const interpolationLerp = state.recordingActive && isMobileViewport() ? 0.12 : 0.04;
  state.splatInterpolation += (state.splatInterpolationTarget - state.splatInterpolation) * interpolationLerp;
  if (Math.abs(state.splatInterpolation - state.splatInterpolationTarget) < 0.001) {
    state.splatInterpolation = state.splatInterpolationTarget;
  }
  // Update rendering and interaction based on active engine
  if (state.isModelLoaded) {
    // 1. Sync splat pivot rotation with particle system pivot rotation
    if (state.splatPivot && state.particleSystem && state.particleSystem.pivot) {
      state.splatPivot.rotation.y = state.particleSystem.pivot.rotation.y;
    }
    // 2. Update opacity of Spark SplatMesh (fade in as splatInterpolation goes to 1.0)
    if (state.splatMesh) {
      const splatOpacity = transitionDirection > 0
        ? Math.pow(state.splatInterpolation, 2.1)
        : Math.pow(state.splatInterpolation, 1.45);
      state.splatMesh.opacity = splatOpacity;
    }
    syncModelRendererVisibility();
    // 3. Update Particle System (fades out internally in shader)
    if (state.particleSystem) {
      if (state.particleSystem.material) {
        // depthWrite stays false for artistic AdditiveBlending glow;
        // no dynamic toggling needed anymore
      }
      state.particleSystem.setTransitionDirection(transitionDirection);
      state.particleSystem.setSplatInterpolation(state.splatInterpolation);
      state.particleSystem.update(renderDelta, renderElapsed);
      const progress = state.particleSystem.getProgress();
      const progressPercent = Math.round(progress * 100);
      if (progressPercent !== state.lastProgressPercent) {
        state.lastProgressPercent = progressPercent;
        if (dom.statProgress) dom.statProgress.textContent = `${progressPercent}%`;
        // Avoid layout/style work on every animation frame.
        if (!state.manualControl) {
          dom.progressSlider.value = progressPercent;
          dom.progressValue.textContent = `${progressPercent}%`;
        }
      }
    }
  }
  // Camera Path Flight Animation (interpolates camera positions and targets)
  if (state.previewActive) {
    if (state.settings.presetFlight === 'none') {
      state.previewTime += renderDelta;
      const totalDuration = (state.keyframes.length - 1) * 2.0; // 2.0 seconds per segment (max 8.0s for 5 keyframes)
      if (state.previewTime >= totalDuration) {
        state.previewActive = false;
        setPreviewControlsActive(false);
        state.controls.enabled = true; // Restore OrbitControls
        state.controls.update(); // Sync OrbitControls to final viewpoint
        dom.btnPreviewPath.textContent = t('btn-preview-path');
        showToast('Flight preview finished', 'success');
      } else {
        interpolateCamera(state.previewTime / totalDuration);
      }
    }
    // If a preset is active, GSAP handles the progress updates and camera positioning automatically
  } else if (state.recordingActive) {
    state.recordTime += renderDelta;
    const totalDuration = state.settings.presetFlight !== 'none'
      ? getPresetFlightDuration(state.settings.presetFlight)
      : (state.keyframes.length - 1) * 2.0;
    const flightProgress = Math.min(state.recordTime / totalDuration, 1);

    if (state.settings.presetFlight !== 'none') {
      applyPresetFlight(state.settings.presetFlight, flightProgress);
    } else {
      interpolateCamera(flightProgress);
    }
    
    if (state.recordTime >= totalDuration) {
      state.recordingActive = false;
      state.controls.enabled = true; // Restore OrbitControls
      // Stop after this animation turn has rendered its exact t=1 endpoint.
      const recorder = state.mediaRecorder;
      if (recorder && recorder.state !== 'inactive') {
        setTimeout(() => {
          if (recorder.state !== 'inactive') recorder.stop();
        }, 0);
      }
      
      // Restore camera FOV & clipping planes
      if (state.settings.originalFov) {
        state.camera.fov = state.settings.originalFov;
      }
      state.camera.near = 0.1;
      state.camera.far = 1000;
      state.camera.updateProjectionMatrix();
      
      state.controls.update(); // Sync OrbitControls to final viewpoint
    }
  }
  // Update landing page galaxy background and apply mouse parallax depth effect
  if (state.landingBg) {
    if (state.isModelLoaded) {
      if (state.landingBg.visible) {
        state.landingBg.visible = false;
        state.landingBg.points.visible = false;
      }
    } else {
      if (!state.landingBg.visible) {
        state.landingBg.visible = true;
        state.landingBg.points.visible = true;
      }
      state.landingBg.update(renderElapsed);
      
      // 1. Smoothly interpolate mouse target coordinates for soft camera shift (lagging inertia)
      state.cameraParallax.x += (state.mouseTarget.x * 0.18 - state.cameraParallax.x) * 0.05;
      state.cameraParallax.y += (state.mouseTarget.y * 0.12 - state.cameraParallax.y) * 0.05;
      
      // 2. Set camera position using mouse interactive parallax (removing periodic automatic floating oscillations)
      state.camera.position.x = state.cameraParallax.x;
      state.camera.position.y = 0.15 + state.cameraParallax.y;
      state.camera.position.z = 1.25; // Keep steady viewing zoom
      state.camera.lookAt(0, 0, 0);
    }
  }

  // Update controls (only if not in active camera flight, and only if model is loaded to bypass landing parallax override)
  if (!state.previewActive && !state.recordingActive && state.isModelLoaded) {
    state.controls.update();
  }
  // Render
  state.renderer.render(state.scene, state.camera);
}
// ============================================================
// Renderer Mode Toggle (Spark 2.0 vs Particles)
// ============================================================
function updateRendererUI() {
  if (!dom.btnToggleSpark) return;
  const iconSpan = dom.btnToggleSpark.querySelector('.btn-icon-emoji');
  const textSpan = dom.btnToggleSpark.querySelector('.btn-text');
  
  const dict = translations[state.lang];
  if (state.settings.renderer === 'spark') {
    dom.btnToggleSpark.classList.add('active');
    if (iconSpan) iconSpan.textContent = '✨';
    const text = dict ? dict['btn-spark-text'] : '3D Reality';
    if (textSpan) textSpan.textContent = text;
    else dom.btnToggleSpark.textContent = '✨' + text;
  } else {
    dom.btnToggleSpark.classList.remove('active');
    if (iconSpan) iconSpan.textContent = '☁️';
    const text = dict ? dict['btn-pointcloud-text'] : 'Particle Mode';
    if (textSpan) textSpan.textContent = text;
    else dom.btnToggleSpark.textContent = '☁️' + text;
  }

  [dom.btnPreviewToggleRenderer, dom.btnRecordingToggleRenderer].forEach((button) => {
    if (!button) return;
    button.textContent = state.settings.renderer === 'spark'
      ? (state.lang === 'zh' ? '切换粒子' : 'Switch to Particles')
      : (state.lang === 'zh' ? '切换实景' : 'Switch to Reality');
  });
  
  // Show progress control ONLY in point cloud mode and when model is loaded
  if (dom.progressControl) {
    if (state.isModelLoaded && state.settings.renderer === 'particles') {
      dom.progressControl.classList.add('visible');
    } else {
      dom.progressControl.classList.remove('visible');
    }
    if (typeof updateRemyPosition === 'function') {
      updateRemyPositionDeferred();
    }
  }
}
function toggleRendererMode(source = 'gesture') {
  const newMode = state.settings.renderer === 'spark' ? 'particles' : 'spark';
  state.settings.renderer = newMode;
  updateRendererUI();
  if (source === 'gesture') {
    if (newMode === 'spark') {
      showToast(t('gesture-switched-spark'), 'success', 2000);
    } else {
      showToast(t('gesture-switched-cloud'), 'info', 2000);
    }
  } else {
    if (newMode === 'spark') {
      showToast(t('spark-mode-enabled'), 'success', 2000);
    } else {
      showToast(t('point-cloud-enabled'), 'info', 2000);
    }
  }
}
// ============================================================
// Camera Path Export & Video Recording (1080p MP4)
// ============================================================
function toggleCameraMode() {
  if (!state.isModelLoaded) {
    showToast('Please load a model first', 'warning');
    return;
  }
  
  state.cameraModeActive = !state.cameraModeActive;
  dom.btnCameraMode.classList.toggle('active', state.cameraModeActive);
  dom.cameraPathPanel.classList.toggle('hidden', !state.cameraModeActive);
  document.body.classList.toggle('camera-path-active', state.cameraModeActive);
  
  if (state.cameraModeActive) {
    // Hide settings panel if open
    dom.settingsPanel.classList.add('hidden');
    dom.btnSettings.classList.remove('active');
    document.body.classList.remove('settings-panel-active');
    
    // Pause auto-rotation immediately
    if (state.particleSystem) {
      state.particleSystem.autoRotate = false;
    }
    showToast('Camera Path Mode active: Adjust view and record keyframes!', 'success');
  } else {
    // Restore autoRotate
    if (state.particleSystem) {
      state.particleSystem.autoRotate = true;
      state.particleSystem.isGestureActive = state.isGestureActive;
    }
  }
}

function collapseCameraPathPanel() {
  state.cameraModeActive = false;
  dom.btnCameraMode.classList.remove('active');
  dom.cameraPathPanel.classList.add('hidden');
  document.body.classList.remove('camera-path-active');
}

function openCameraPathPanel() {
  state.cameraModeActive = true;
  dom.btnCameraMode.classList.add('active');
  dom.cameraPathPanel.classList.remove('hidden');
  document.body.classList.add('camera-path-active');
}
function addKeyframe() {
  if (!state.isModelLoaded) return;
  if (state.keyframes.length >= 5) {
    showToast('Maximum 5 keyframes allowed', 'warning');
    return;
  }
  
  state.keyframes.push({
    position: state.camera.position.clone(),
    target: state.controls.target.clone()
  });
  
  updateKeyframeUI();
  showToast(`Keyframe ${state.keyframes.length} recorded!`, 'success');
}
function clearKeyframes() {
  state.keyframes = [];
  updateKeyframeUI();
  showToast('All keyframes cleared', 'info');
}
function updateKeyframeUI() {
  dom.keyframeList.innerHTML = '';
  
  state.keyframes.forEach((kf, i) => {
    const item = document.createElement('div');
    item.className = 'keyframe-item';
    
    const label = document.createElement('span');
    label.textContent = `${state.lang === 'zh' ? '视角' : 'Viewpoint'} ${i + 1}`;
    item.appendChild(label);
    
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove keyframe';
    removeBtn.addEventListener('click', () => {
      removeKeyframe(i);
    });
    item.appendChild(removeBtn);
    
    dom.keyframeList.appendChild(item);
  });

  requestAnimationFrame(() => {
    if (isMobileViewport()) {
      dom.keyframeList.scrollLeft = dom.keyframeList.scrollWidth;
    } else {
      dom.keyframeList.scrollTop = dom.keyframeList.scrollHeight;
    }
  });
  
  dom.keyframeCount.textContent = state.keyframes.length;
  if (state.settings.presetFlight !== 'none') {
    dom.btnPreviewPath.disabled = false;
    dom.btnHeaderPreview.disabled = false;
    dom.btnExportVideo.disabled = false;
  } else {
    dom.btnPreviewPath.disabled = state.keyframes.length < 2;
    dom.btnHeaderPreview.disabled = state.keyframes.length < 2;
    dom.btnExportVideo.disabled = state.keyframes.length < 2;
  }
}
function removeKeyframe(index) {
  state.keyframes.splice(index, 1);
  updateKeyframeUI();
  showToast('Keyframe removed', 'info');
}
function initCameraCurves() {
  if (state.keyframes.length < 2) return false;
  const targets = state.keyframes.map(kf => kf.target);
  const sphericalPoints = [];
  let lastTheta = 0;
  state.keyframes.forEach((kf, idx) => {
    const offset = new THREE.Vector3().copy(kf.position).sub(kf.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    
    if (idx === 0) {
      lastTheta = spherical.theta;
    } else {
      // Unwrap theta to avoid 360-degree reversing spins
      const diff = spherical.theta - lastTheta;
      const unwrappedDiff = Math.atan2(Math.sin(diff), Math.cos(diff));
      spherical.theta = lastTheta + unwrappedDiff;
      lastTheta = spherical.theta;
    }
    
    // Store spherical coordinates (radius, theta, phi) in a Vector3 for spline pathing
    sphericalPoints.push(new THREE.Vector3(spherical.radius, spherical.theta, spherical.phi));
  });
  state.cameraSphericalCurve = new THREE.CatmullRomCurve3(sphericalPoints);
  state.cameraSphericalCurve.curveType = 'centripetal';
  state.targetCurve = new THREE.CatmullRomCurve3(targets);
  state.targetCurve.curveType = 'centripetal';
  
  return true;
}
function interpolateCamera(pct) {
  if (!state.cameraSphericalCurve || !state.targetCurve) return;
  
  // getPointAt(pct) uses arc-length parameterization for perfectly constant velocity (no acceleration drops)
  const sphereCoords = state.cameraSphericalCurve.getPointAt(pct);
  const newTarget = state.targetCurve.getPointAt(pct);
  
  const spherical = new THREE.Spherical();
  spherical.radius = sphereCoords.x;
  spherical.theta = sphereCoords.y;
  spherical.phi = sphereCoords.z;
  
  const offset = new THREE.Vector3().setFromSpherical(spherical);
  const newPos = new THREE.Vector3().copy(newTarget).add(offset);
  
  state.camera.position.copy(newPos);
  state.camera.lookAt(newTarget);
  state.controls.target.copy(newTarget);
}

/**
 * Apply dynamic preset camera flight based on Frustum Fitting math,
 * relative to user's real-time focus target.
 */
function getPresetFlightDuration(presetName) {
  return presetName === 'verticalLoop' ? 16.0 : 8.0;
}

function applyPresetFlight(presetName, t) {
  if (!state.isModelLoaded) return;
  
  // 1. Focus point (user's real-time line-of-sight target)
  const focusPoint = state.controls.target;
  
  // 2. Fetch starting spherical viewpoint coordinates to ensure no fixed model zoom
  const startSph = state.settings.flightStartSpherical || { radius: 1.0, phi: Math.PI / 2, theta: 0 };
  const r0 = startSph.radius;
  const phi0 = startSph.phi;
  const theta0 = startSph.theta;
  
  const phiVal = 2 * Math.PI * t;
  
  let r = r0;
  let p = phi0;
  let th = theta0 + phiVal; // default azimuthal rotation around target
  
  // Reset camera FOV to original before computing
  state.camera.fov = state.settings.originalFov;
  
  switch (presetName) {
    case 'orbit360':
      // Keeps starting distance and pitch, rotates azimuthally
      r = r0;
      p = phi0;
      th = theta0 + phiVal;
      break;
      
    case 'verticalLoop':
      // Sweeps vertically 180 degrees over the top (above X axis) from front to back (t in [0.0, 0.25]),
      // and then orbits 360 degrees horizontally back to the front view (t in [0.25, 1.0]).
      // The yaw velocity (dth/dt) is perfectly constant (4 * PI rad/s) throughout the entire path,
      // and the pitch velocity (dp/dt) smoothly eases to 0 at t=0 and t=0.25 to prevent jerkiness.
      r = r0;
      th = theta0 + t * 4 * Math.PI;
      if (t < 0.25) {
        const u = t / 0.25;
        p = phi0 - (phi0 - 0.1) * Math.sin(u * Math.PI) * Math.sin(u * Math.PI);
      } else {
        p = phi0;
      }
      break;
      
    case 'figure8':
      // Infinity loop relative to user's current pitch and yaw
      r = r0;
      p = phi0 + Math.sin(2 * phiVal) * 0.3;
      th = theta0 + phiVal;
      break;
      
    case 'spiralHelix':
      // Spiral zoom relative to user's distance
      r = r0 * (1.0 - Math.sin(Math.PI * t) * 0.4);
      p = phi0 + Math.cos(phiVal) * 0.2;
      th = theta0 + phiVal;
      break;
      
    case 'sinusoidWave':
      // Orbit with sinusoidal altitude wave
      r = r0;
      p = phi0 + Math.sin(6 * phiVal) * 0.1;
      th = theta0 + phiVal;
      break;
      
    case 'panZoomScan':
      // Close up pan and zoom scan
      r = r0 * (1.0 - Math.cos(phiVal) * 0.3);
      p = phi0 + Math.cos(phiVal) * 0.15;
      th = theta0 + Math.sin(phiVal) * 0.5;
      break;
      
    case 'dollyZoom':
      // Hitchcock dolly zoom: varies distance and FOV inversely
      r = r0 * (1.0 + Math.sin(phiVal) * 0.4);
      p = phi0;
      th = theta0 + phiVal;
      
      const baseTan = Math.tan((state.settings.originalFov * Math.PI) / 360);
      const k = 1.0 + Math.sin(phiVal) * 0.4;
      state.camera.fov = 2 * Math.atan(baseTan * k) * (180 / Math.PI);
      break;
      
    case 'butterfly':
      // Butterfly shape path on sphere
      r = r0;
      p = phi0 + Math.sin(2 * phiVal) * 0.2;
      th = theta0 + Math.sin(phiVal) * Math.cos(phiVal) * 1.5;
      break;
      
    case 'pendulum':
      // Swing back and forth like a pendulum
      r = r0;
      p = phi0;
      th = theta0 + Math.sin(phiVal) * 1.0;
      break;
      
    case 'heroSweep':
      // Sweep looking up from a lower angle
      r = r0;
      p = Math.min(Math.PI - 0.1, phi0 + 0.25);
      th = theta0 + phiVal;
      break;
      
    case 'macroRing':
      // Close-up macro orbit
      r = r0 * 0.45;
      p = phi0;
      th = theta0 + phiVal;
      break;
      
    case 'zenithSpiral':
      // Zenith polar spiral path
      r = r0;
      p = Math.acos(Math.cos(phiVal) * 0.95);
      th = theta0 + 2 * phiVal;
      break;
      
    case 'rhombic':
      // Rhombic square path on azimuthal plane
      const rRhombic = 1.0 / (Math.abs(Math.sin(phiVal)) + Math.abs(Math.cos(phiVal)));
      r = r0 * rRhombic;
      p = phi0;
      th = theta0 + phiVal;
      break;
      
    case 'heart':
      // Heart-shaped orbit in 3D
      r = r0 * (1.0 - Math.sin(phiVal) * 0.4);
      p = phi0 + Math.cos(phiVal) * 0.15;
      th = theta0 + Math.sin(phiVal) * 0.5;
      break;
      
    case 'turbulence':
      // Turbulence chaos orbit
      r = r0 * (1.0 + 0.15 * Math.sin(3 * phiVal));
      p = phi0 + 0.1 * Math.sin(2 * phiVal) + 0.05 * Math.cos(phiVal);
      th = theta0 + phiVal + 0.15 * Math.sin(3 * phiVal);
      break;
      
    default:
      return;
  }
  
  // 4. Construct relative spherical coordinates position vector
  const targetSpherical = new THREE.Spherical(r, p, th);
  targetSpherical.makeSafe(); // clamp polar angle to prevent camera flipping at poles
  
  const offsetVector = new THREE.Vector3().setFromSpherical(targetSpherical);
  const cameraPos = new THREE.Vector3().copy(focusPoint).add(offsetVector);
  
  state.camera.position.copy(cameraPos);
  state.camera.lookAt(focusPoint);
  
  // 5. Dynamic Min/Max camera space near/far clipping boundaries (optimized to avoid redundant projection matrix re-computations)
  const d = cameraPos.distanceTo(focusPoint);
  const targetNear = Math.max(0.01, d - 1.5);
  const targetFar = (state.settings.renderer === 'spark') ? 1000.0 : d + 3.0;
  if (Math.abs(state.camera.near - targetNear) > 0.02 || Math.abs(state.camera.far - targetFar) > 0.02) {
    state.camera.near = targetNear;
    state.camera.far = targetFar;
    state.camera.updateProjectionMatrix();
  }
}

function capturePreviewStart() {
  state.previewStart = {
    position: state.camera.position.clone(),
    target: state.controls.target.clone(),
    fov: state.camera.fov
  };
}

function restorePreviewStart() {
  if (!state.previewStart) return;
  state.camera.position.copy(state.previewStart.position);
  state.controls.target.copy(state.previewStart.target);
  state.camera.fov = state.previewStart.fov;
  state.camera.updateProjectionMatrix();
  state.controls.update();
}

function setPreviewControlsActive(active) {
  document.body.classList.toggle('preview-mode-active', active);
}

function setRecordingControlsActive(active) {
  document.body.classList.toggle('recording-mode-active', active);
}

function playGatherOnlyAnimation() {
  if (!state.particleSystem || !state.settings.particleEffectEnabled) {
    state.particleSystem?.setProgressImmediate(0);
    dom.progressSlider.value = 0;
    dom.progressValue.textContent = '0%';
    return;
  }
  if (state.gatherAnimationId) cancelAnimationFrame(state.gatherAnimationId);

  state.manualControl = true;
  state.particleSystem.setProgressImmediate(1);
  dom.progressSlider.value = 100;
  dom.progressValue.textContent = '100%';
  const startedAt = performance.now();
  const duration = 2500;

  const animateGather = (now) => {
    const progress = Math.max(0, 1 - (now - startedAt) / duration);
    state.particleSystem.setProgressImmediate(progress);
    dom.progressSlider.value = Math.round(progress * 100);
    dom.progressValue.textContent = `${Math.round(progress * 100)}%`;
    if (progress > 0) {
      state.gatherAnimationId = requestAnimationFrame(animateGather);
    } else {
      state.gatherAnimationId = null;
      state.manualControl = false;
    }
  };

  state.gatherAnimationId = requestAnimationFrame(animateGather);
}

function stopPreviewFlight({ reopenPanel = true } = {}) {
  state.previewActive = false;
  setPreviewControlsActive(false);
  if (state.gatherAnimationId) {
    cancelAnimationFrame(state.gatherAnimationId);
    state.gatherAnimationId = null;
    state.manualControl = false;
  }
  state.controls.enabled = true;
  
  if (state.presetAnimation) {
    state.presetAnimation.kill();
    state.presetAnimation = null;
  }
  
  // Restore original FOV & clipping planes
  if (state.settings.originalFov) {
    state.camera.fov = state.settings.originalFov;
  }
  state.camera.near = 0.1;
  state.camera.far = 1000;
  state.camera.updateProjectionMatrix();
  
  state.controls.update();
  dom.btnPreviewPath.textContent = t('btn-preview-path');
  if (reopenPanel) openCameraPathPanel();
  showToast('Flight preview stopped', 'info');
}

function startPreviewFlight() {
  capturePreviewStart();
  state.cancelScatterAnimation?.();
  playGatherOnlyAnimation();

  if (state.settings.presetFlight !== 'none') {
    collapseCameraPathPanel();
    state.controls.enabled = false; // Disable user interaction during flight preview
    state.previewActive = true;
    setPreviewControlsActive(true);
    
    // Record current camera position relative to target in spherical coordinates (no fixed zoom)
    const offset = new THREE.Vector3().copy(state.camera.position).sub(state.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    state.settings.flightStartSpherical = {
      radius: spherical.radius,
      phi: spherical.phi,
      theta: spherical.theta
    };
    
    if (state.presetAnimation) {
      state.presetAnimation.kill();
    }
    
    state.presetProgressObj = { value: 0 };
    state.settings.originalFov = state.camera.fov; // cache base FOV
    
    const duration = getPresetFlightDuration(state.settings.presetFlight);
    state.presetAnimation = gsap.to(state.presetProgressObj, {
      value: 1,
      duration: duration,
      ease: "none",
      repeat: -1, // infinite loop for closed-loop preview
      onUpdate: () => {
        applyPresetFlight(state.settings.presetFlight, state.presetProgressObj.value);
      }
    });
    
    dom.btnPreviewPath.textContent = state.lang === 'zh' ? '停止' : 'Stop Preview';
    showToast(`Looping preset: ${state.settings.presetFlight}`, 'info');
  } else {
    if (state.keyframes.length < 2) return;
    if (!initCameraCurves()) return;
    
    collapseCameraPathPanel();
    state.controls.enabled = false; // Disable user interaction during flight preview
    state.previewTime = 0.0;
    state.previewActive = true;
    setPreviewControlsActive(true);
    dom.btnPreviewPath.textContent = state.lang === 'zh' ? '停止' : 'Stop Preview';
    showToast('Previewing camera flight path...', 'info');
  }
}

function isMobileViewport() {
  return window.matchMedia('(max-width: 600px), (pointer: coarse)').matches;
}

function selectRecordingMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';

  const candidates = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4;codecs=h264',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];

  if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function restoreRendererAfterExport(width, height, pixelRatio) {
  dom.container.classList.remove('export-aspect-active');
  dom.container.style.removeProperty('--export-canvas-width');
  dom.container.style.removeProperty('--export-canvas-height');
  state.renderer.setPixelRatio(pixelRatio);
  state.renderer.setSize(width, height, true);
  state.camera.aspect = width / height;
  state.camera.updateProjectionMatrix();
  if (state.particleSystem) {
    state.particleSystem.setViewportSize(width, height);
    state.particleSystem.setPointSize(state.settings.pointSize);
  }
  state.controls.enabled = true;
  state.controls.update();
}

function showMobileExportSheet(blob, filename) {
  document.querySelector('.mobile-export-sheet')?.remove();

  const url = URL.createObjectURL(blob);
  const sheet = document.createElement('div');
  sheet.className = 'mobile-export-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');

  const card = document.createElement('div');
  card.className = 'mobile-export-card';
  const title = document.createElement('h3');
  title.textContent = state.lang === 'zh' ? '视频已生成' : 'Video ready';
  const description = document.createElement('p');
  description.textContent = state.lang === 'zh'
    ? '请点击下方按钮保存到手机。'
    : 'Tap below to save the video.';
  const actions = document.createElement('div');
  actions.className = 'mobile-export-actions';

  const download = document.createElement('a');
  download.className = 'btn btn-primary';
  download.href = url;
  download.download = filename;
  download.textContent = state.lang === 'zh' ? '保存视频' : 'Save video';
  download.addEventListener('click', () => {
    setTimeout(() => {
      URL.revokeObjectURL(url);
      sheet.remove();
    }, 3000);
  });
  actions.appendChild(download);

  const cancel = document.createElement('button');
  cancel.className = 'btn btn-secondary';
  cancel.textContent = state.lang === 'zh' ? '取消保存' : 'Cancel save';
  cancel.addEventListener('click', () => {
    URL.revokeObjectURL(url);
    sheet.remove();
  });
  actions.appendChild(cancel);

  card.append(title, description, actions);
  sheet.appendChild(card);
  document.body.appendChild(sheet);
}

function deliverVideoBlob(blob, filename) {
  if (isMobileViewport()) {
    showMobileExportSheet(blob, filename);
    return;
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stopExportRecording() {
  if (!state.recordingActive) return;
  state.recordingActive = false;
  state.controls.enabled = true;
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.stop();
  }
  if (state.settings.originalFov) state.camera.fov = state.settings.originalFov;
  state.camera.near = 0.1;
  state.camera.far = 1000;
  state.camera.updateProjectionMatrix();
  state.controls.update();
}

async function exportPathVideo({ fromPreview = false } = {}) {
  if (state.settings.presetFlight === 'none' && state.keyframes.length < 2) return;
  if (state.recordingActive) return;
  if (state.previewActive && !fromPreview) return;
  state.cancelScatterAnimation?.();

  if (fromPreview) {
    stopPreviewFlight({ reopenPanel: false });
    restorePreviewStart();
  }
  
  if (state.settings.presetFlight === 'none') {
    if (!initCameraCurves()) return;
  } else {
    // Cache original FOV and starting spherical coordinates for video export
    state.settings.originalFov = state.camera.fov;
    const offset = new THREE.Vector3().copy(state.camera.position).sub(state.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    state.settings.flightStartSpherical = {
      radius: spherical.radius,
      phi: spherical.phi,
      theta: spherical.theta
    };
  }
  
  state.controls.enabled = false; // Disable user interaction during export recording
  const mobileExport = isMobileViewport();
  const mobileAspect = window.innerWidth / window.innerHeight;
  const exportWidth = mobileExport
    ? (mobileAspect <= 1 ? 1080 : Math.round(1080 * mobileAspect / 2) * 2)
    : 1920;
  const exportHeight = mobileExport
    ? (mobileAspect <= 1 ? Math.round(1080 / mobileAspect / 2) * 2 : 1080)
    : 1080;
  const exportFps = mobileExport ? 30 : 60;
  collapseCameraPathPanel();
  showLoading(mobileExport ? '正在按当前屏幕比例准备 1080p 高清视频...' : 'Configuring 1080p WebGL render...');
  
  // Wait a moment for UI rendering
  await new Promise(resolve => setTimeout(resolve, 300));
  
  // Save current window scale and pixel ratio
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;
  const pixelRatio = state.renderer.getPixelRatio();
  
  try {
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('This browser does not support MediaRecorder');
    }

    state.renderer.setPixelRatio(1);
    state.renderer.setSize(exportWidth, exportHeight, false);
    // Spark and Three.js must observe the same CSS and drawing-buffer aspect.
    // Fit the export canvas inside the viewport without non-uniform stretching.
    const displayScale = Math.min(originalWidth / exportWidth, originalHeight / exportHeight);
    dom.container.style.setProperty('--export-canvas-width', `${Math.round(exportWidth * displayScale)}px`);
    dom.container.style.setProperty('--export-canvas-height', `${Math.round(exportHeight * displayScale)}px`);
    dom.container.classList.add('export-aspect-active');
    state.camera.aspect = exportWidth / exportHeight;
    state.camera.updateProjectionMatrix();
    if (state.particleSystem) {
      state.particleSystem.setViewportSize(exportWidth, exportHeight);
      // Match the preview's physical point size. The interactive renderer already
      // draws at `pixelRatio`, so omitting it here made exported glow sprites about
      // 1.5× too large and visibly softer on high-DPI phones.
      const previewBufferWidth = originalWidth * pixelRatio;
      const previewBufferHeight = originalHeight * pixelRatio;
      const exportScale = Math.min(
        exportWidth / previewBufferWidth,
        exportHeight / previewBufferHeight
      );
      state.particleSystem.setPointSize(state.settings.pointSize * exportScale);
    }

    // Warm Spark's first sort/upload before capture begins. Otherwise switching
    // from particles to reality can make the first recorded Spark frames stall.
    if (mobileExport && state.settings.renderer === 'particles' && state.splatMesh) {
      const previousMeshVisible = state.splatMesh.visible;
      const previousPivotVisible = state.splatPivot?.visible;
      const previousRendererVisible = state.sparkRenderer?.visible;
      const previousOpacity = state.splatMesh.opacity;
      if (state.splatPivot) state.splatPivot.visible = true;
      if (state.sparkRenderer) state.sparkRenderer.visible = true;
      state.splatMesh.visible = true;
      state.splatMesh.opacity = 0.001;
      state.renderer.render(state.scene, state.camera);
      await new Promise(resolve => requestAnimationFrame(resolve));
      state.renderer.render(state.scene, state.camera);
      state.splatMesh.opacity = previousOpacity;
      state.splatMesh.visible = previousMeshVisible;
      if (state.splatPivot) state.splatPivot.visible = previousPivotVisible;
      if (state.sparkRenderer) state.sparkRenderer.visible = previousRendererVisible;
    }

    state.renderer.render(state.scene, state.camera);

    const canvas = state.renderer.domElement;
    if (typeof canvas.captureStream !== 'function') {
      throw new Error('Canvas video capture is not supported by this browser');
    }
    const stream = canvas.captureStream(exportFps);
    state.exportStream = stream;

    const mimeType = selectRecordingMimeType();
    const recorderOptions = {
      videoBitsPerSecond: mobileExport ? 15000000 : 20000000
    };
    if (mimeType) recorderOptions.mimeType = mimeType;

    const chunks = [];
    const recorder = new MediaRecorder(stream, recorderOptions);
  
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };

    recorder.onerror = (event) => {
      state.recordingActive = false;
      setRecordingControlsActive(false);
      state.exportStream?.getTracks().forEach(track => track.stop());
      restoreRendererAfterExport(originalWidth, originalHeight, pixelRatio);
      hideLoading();
      showToast(`${state.lang === 'zh' ? '视频导出失败' : 'Video export failed'}: ${event.error?.message || 'Recorder error'}`, 'error', 6000);
    };

    recorder.onstop = () => {
      setRecordingControlsActive(false);
      state.exportStream?.getTracks().forEach(track => track.stop());
      state.exportStream = null;
      const actualType = recorder.mimeType || mimeType || 'video/webm';
      const rawBlob = new Blob(chunks, { type: actualType });
      const totalDurationMs = state.settings.presetFlight !== 'none'
        ? getPresetFlightDuration(state.settings.presetFlight) * 1000
        : (state.keyframes.length - 1) * 2000;

      const finishExport = (blobToDownload) => {
        const isMp4 = actualType.includes('mp4');
        const ext = isMp4 ? 'mp4' : 'webm';
        const filename = `${state.lastLoadedName || 'splat'}_render.${ext}`;
        restoreRendererAfterExport(originalWidth, originalHeight, pixelRatio);
        hideLoading();

        if (!blobToDownload.size) {
          showToast(state.lang === 'zh' ? '浏览器没有生成视频数据，请尝试使用最新版 Safari 或 Chrome' : 'No video data was generated. Try the latest Safari or Chrome.', 'error', 7000);
          return;
        }

        deliverVideoBlob(blobToDownload, filename);
        showToast(isMp4
          ? (state.lang === 'zh' ? 'MP4 已生成，请保存到手机' : 'MP4 ready to save')
          : (state.lang === 'zh' ? '当前浏览器仅支持 WebM，视频已生成' : 'This browser supports WebM export; video ready'), 'success', 6000);
      };

      if (actualType.includes('webm')) {
        fixWebmDuration(rawBlob, totalDurationMs, finishExport);
      } else {
        finishExport(rawBlob);
      }
    };

    state.mediaRecorder = recorder;
    state.recordTime = 0.0;
    state.recordingFps = exportFps;
    state.lastRecordFrameTime = performance.now();
    state.lastRecordRenderDelta = 1 / exportFps;
    state.recordFrameAccumulator = 0;
    state.virtualElapsedTime = 0.0;
    state.recordingActive = true;
    setRecordingControlsActive(true);
    recorder.start(1000);
    playGatherOnlyAnimation();

    hideLoading();
    showToast(mobileExport
      ? (state.lang === 'zh' ? '正在录制 1080p 高清运镜视频，请保持页面打开…' : 'Recording a 1080p camera flight. Keep this page open…')
      : 'Recording 1080p MP4 camera flight...', 'info', 6000);
  } catch (error) {
    state.recordingActive = false;
    setRecordingControlsActive(false);
    state.exportStream?.getTracks().forEach(track => track.stop());
    state.exportStream = null;
    restoreRendererAfterExport(originalWidth, originalHeight, pixelRatio);
    hideLoading();
    showToast(`${state.lang === 'zh' ? '此手机浏览器暂不支持视频导出' : 'Video export is not supported in this browser'}: ${error.message}`, 'error', 7000);
    console.error('Video export setup failed:', error);
  }
}
// ============================================================
// Event Handlers
// ============================================================
function setupEventListeners() {
  // Load from URL
  dom.btnLoad.addEventListener('click', loadFromUrl);
  dom.urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadFromUrl();
  });
  // Load from Landing Input
  if (dom.landingBtnLoad) {
    dom.landingBtnLoad.addEventListener('click', () => {
      let url = dom.landingUrlInput.value.trim();
      if (!url) {
        // Default demo model
        url = 'https://www.remy3d.cn/model/72ca9c87bca54600bfd0fdd95fa96e38';
        dom.landingUrlInput.value = url;
        showToast(state.lang === 'zh' ? '加载示例图像……' : 'Loading demo model...', 'info', 3000);
      }
      dom.urlInput.value = url;
      loadFromUrl();
    });
  }
  if (dom.landingUrlInput) {
    dom.landingUrlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const url = dom.landingUrlInput.value.trim();
        if (url) {
          dom.urlInput.value = url;
          loadFromUrl();
        }
      }
    });
  }
  // Load from file
  dom.btnUpload.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadFromFile(file);
  });
  // Download PLY/Splat file
  dom.btnDownload.addEventListener('click', () => {
    if (!state.lastLoadedBuffer) return;
    
    // Detect if it is a compressed splat file
    const headerText = new TextDecoder().decode(new Uint8Array(state.lastLoadedBuffer.slice(0, 1024)));
    const isSplat = headerText.includes('element chunk');
    
    if (isSplat) {
      showToast('Converting splat data to standard PLY format...', 'info', 2000);
      
      // We parse the entire splat file in memory (no cropping, maximum resolution) to export it
      try {
        const data = parsePLY(state.lastLoadedBuffer, null, {
          maxParticles: 2000000, // export all particles
          cropOutliers: false,   // export complete scene
          minOpacity: 0.0        // do not filter out low-opacity particles
        });
        
        const plyBuffer = exportToPLY(data);
        const filename = `${state.lastLoadedName}.ply`;
        
        const blob = new Blob([plyBuffer], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast(`Downloaded ${filename} successfully`, 'success');
      } catch (err) {
        console.error('Export to PLY failed:', err);
        showToast(`Export failed: ${err.message}. Downloading raw splat file instead.`, 'error');
        
        // Fallback to downloading raw splat file
        const filename = `${state.lastLoadedName}.splat`;
        const blob = new Blob([state.lastLoadedBuffer], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } else {
      // Standard PLY - download raw
      const filename = `${state.lastLoadedName}.ply`;
      const blob = new Blob([state.lastLoadedBuffer], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(`Downloaded ${filename} successfully`, 'success');
    }
  });
  // Gesture toggle
  dom.btnGesture.addEventListener('click', toggleGestureControl);
  // Spark 3DGS toggle
  dom.btnToggleSpark.addEventListener('click', () => toggleRendererMode('button'));
  // Progress slider (manual control)
  let manualControlTimeout = null;
  let scatterAnimationId = null;
  let scatterDirection = 'forward'; // 'forward' or 'backward'

  state.cancelScatterAnimation = () => {
    if (scatterAnimationId) {
      cancelAnimationFrame(scatterAnimationId);
      scatterAnimationId = null;
    }
    state.manualControl = false;
  };

  const updatePlayButtonUI = () => {
    const icon = dom.btnPlayScatter ? dom.btnPlayScatter.querySelector('.btn-icon-emoji') : null;
    if (!icon) return;
    
    if (scatterDirection === 'forward') {
      icon.textContent = state.lang === 'zh' ? '播放' : 'PLAY';
    } else {
      icon.textContent = state.lang === 'zh' ? '倒放' : 'REV';
    }
  };

  const playScatterAnimation = () => {
    if (scatterAnimationId) {
      cancelAnimationFrame(scatterAnimationId);
      scatterAnimationId = null;
    }
    
    state.manualControl = true;
    
    const startVal = state.particleSystem ? state.particleSystem.getProgress() : (scatterDirection === 'forward' ? 0.0 : 1.0);
    const targetVal = scatterDirection === 'forward' ? 1.0 : 0.0;
    
    const totalDuration = 2500; // 2.5 seconds for a full 0 to 100 / 100 to 0 transition
    const actualDuration = totalDuration * Math.abs(targetVal - startVal);
    const startTime = performance.now();
    
    updatePlayButtonUI();
    
    const anim = (now) => {
      const elapsed = now - startTime;
      if (elapsed >= actualDuration) {
        if (state.particleSystem) {
          state.particleSystem.setProgressImmediate(targetVal);
        }
        dom.progressSlider.value = Math.round(targetVal * 100);
        dom.progressValue.textContent = `${Math.round(targetVal * 100)}%`;
        
        scatterDirection = scatterDirection === 'forward' ? 'backward' : 'forward';
        updatePlayButtonUI();
        
        state.manualControl = false;
        scatterAnimationId = null;
        return;
      }
      
      const t = elapsed / actualDuration;
      const progress = startVal + (targetVal - startVal) * t;
      
      if (state.particleSystem) {
        state.particleSystem.setProgressImmediate(progress);
      }
      dom.progressSlider.value = Math.round(progress * 100);
      dom.progressValue.textContent = `${Math.round(progress * 100)}%`;
      
      scatterAnimationId = requestAnimationFrame(anim);
    };
    
    scatterAnimationId = requestAnimationFrame(anim);
  };

  const playFullDemoScatterAnimation = () => {
    if (scatterAnimationId) {
      cancelAnimationFrame(scatterAnimationId);
      scatterAnimationId = null;
    }
    
    state.manualControl = true;
    
    const duration = 5000; // 5 seconds total (2.5s forward, 2.5s backward)
    const startTime = performance.now();
    
    updatePlayButtonUI();
    
    const anim = (now) => {
      const elapsed = now - startTime;
      if (elapsed >= duration) {
        if (state.particleSystem) {
          state.particleSystem.setProgressImmediate(0.0);
        }
        dom.progressSlider.value = 0;
        dom.progressValue.textContent = '0%';
        scatterDirection = 'forward';
        updatePlayButtonUI();
        state.manualControl = false;
        scatterAnimationId = null;
        return;
      }
      
      let progress = 0;
      const halfDuration = duration / 2;
      if (elapsed < halfDuration) {
        progress = elapsed / halfDuration;
      } else {
        progress = 1.0 - (elapsed - halfDuration) / halfDuration;
      }
      
      if (state.particleSystem) {
        state.particleSystem.setProgressImmediate(progress);
      }
      dom.progressSlider.value = Math.round(progress * 100);
      dom.progressValue.textContent = `${Math.round(progress * 100)}%`;
      
      scatterAnimationId = requestAnimationFrame(anim);
    };
    
    scatterAnimationId = requestAnimationFrame(anim);
  };

  const releaseManualControl = () => {
    if (manualControlTimeout) clearTimeout(manualControlTimeout);
    manualControlTimeout = setTimeout(() => {
      state.manualControl = false;
    }, 1000);
  };

  if (dom.btnPlayScatter) {
    dom.btnPlayScatter.addEventListener('click', () => {
      if (scatterAnimationId) {
        cancelAnimationFrame(scatterAnimationId);
        scatterAnimationId = null;
        updatePlayButtonUI();
        state.manualControl = false;
      } else {
        const currentProg = state.particleSystem ? state.particleSystem.getProgress() : 0.0;
        if (currentProg >= 0.99) {
          scatterDirection = 'backward';
        } else if (currentProg <= 0.01) {
          scatterDirection = 'forward';
        }
        playScatterAnimation();
      }
    });
  }

  dom.progressSlider.addEventListener('input', (e) => {
    if (scatterAnimationId) {
      cancelAnimationFrame(scatterAnimationId);
      scatterAnimationId = null;
    }
    state.manualControl = true;
    const value = parseFloat(e.target.value) / 100;
    
    if (state.particleSystem) {
      state.particleSystem.setTargetProgress(value);
    }
    dom.progressValue.textContent = `${Math.round(value * 100)}%`;
    
    if (value >= 0.99) {
      scatterDirection = 'backward';
      updatePlayButtonUI();
    } else if (value <= 0.01) {
      scatterDirection = 'forward';
      updatePlayButtonUI();
    }
    
    releaseManualControl();
  });
  
  dom.progressSlider.addEventListener('change', releaseManualControl);
  dom.progressSlider.addEventListener('pointerup', releaseManualControl);
  dom.progressSlider.addEventListener('touchend', releaseManualControl);
  // Drag & drop
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.name.toLowerCase().endsWith('.ply')) {
      loadFromFile(file);
    } else if (file) {
      showToast('Please drop a .ply file', 'error');
    }
  });
  // Paste URL
  dom.urlInput.addEventListener('paste', (e) => {
    setTimeout(() => {
      const text = dom.urlInput.value.trim();
      if (text.includes('remy3d') || text.includes('kiriengine')) {
        // Auto-load after paste with brief delay
        setTimeout(loadFromUrl, 500);
      }
    }, 100);
  });
  // Settings toggle
  dom.btnSettings.addEventListener('click', () => {
    dom.settingsPanel.classList.toggle('hidden');
    dom.btnSettings.classList.toggle('active');
    document.body.classList.toggle('settings-panel-active', !dom.settingsPanel.classList.contains('hidden'));
    
    // Auto-hide camera path panel if settings are opened
    if (state.cameraModeActive) {
      toggleCameraMode();
    }
  });
  // Camera Path mode event listeners
  dom.btnCameraMode.addEventListener('click', toggleCameraMode);
  dom.btnAddKeyframe.addEventListener('click', addKeyframe);
  dom.btnClearKeyframes.addEventListener('click', clearKeyframes);
  dom.btnPreviewPath.addEventListener('click', () => {
    if (state.previewActive) {
      stopPreviewFlight();
    } else {
      startPreviewFlight();
    }
  });
  dom.btnHeaderPreview.addEventListener('click', startPreviewFlight);
  dom.btnPreviewToggleRenderer.addEventListener('click', () => toggleRendererMode('manual'));
  dom.btnPreviewStop.addEventListener('click', stopPreviewFlight);
  dom.btnPreviewExport.addEventListener('click', () => exportPathVideo({ fromPreview: true }));
  dom.btnRecordingToggleRenderer.addEventListener('click', () => toggleRendererMode('manual'));
  dom.btnRecordingStop.addEventListener('click', stopExportRecording);
  dom.btnExportVideo.addEventListener('click', exportPathVideo);

  document.querySelectorAll('.mobile-setting-tag').forEach((tag) => {
    tag.addEventListener('click', () => {
      document.querySelectorAll('.mobile-setting-tag').forEach(item => item.classList.remove('active'));
      document.querySelectorAll('.mobile-parameter').forEach(item => item.classList.remove('mobile-active'));
      tag.classList.add('active');
      document.getElementById(tag.dataset.settingTarget)?.classList.add('mobile-active');
    });
  });

  document.querySelectorAll('.mobile-parameter input[type="range"]').forEach((slider) => {
    const showSettings = () => dom.settingsPanel.classList.remove('adjusting-settings');
    slider.addEventListener('pointerdown', () => dom.settingsPanel.classList.add('adjusting-settings'));
    slider.addEventListener('input', () => dom.settingsPanel.classList.add('adjusting-settings'));
    slider.addEventListener('pointerup', showSettings);
    slider.addEventListener('pointercancel', showSettings);
    slider.addEventListener('change', showSettings);
  });
  
  // Preset flight selection listener
  if (dom.selectPresetFlight) {
    dom.selectPresetFlight.addEventListener('change', (e) => {
      const preset = e.target.value;
      state.settings.presetFlight = preset;
      
      if (preset !== 'none') {
        dom.cameraPathPanel.classList.add('preset-mode');
        dom.customKeyframeActions.style.display = 'none';
        dom.btnAddKeyframe.disabled = true;
        dom.btnClearKeyframes.disabled = true;
        dom.btnPreviewPath.disabled = false;
        dom.btnHeaderPreview.disabled = false;
        dom.btnExportVideo.disabled = false;
        if (state.previewActive) stopPreviewFlight();
      } else {
        dom.cameraPathPanel.classList.remove('preset-mode');
        dom.customKeyframeActions.style.display = '';
        dom.btnAddKeyframe.disabled = false;
        dom.btnClearKeyframes.disabled = false;
        updateKeyframeUI(); // restores correct disabled states based on keyframes
        if (state.previewActive) stopPreviewFlight();
      }
    });
  }

  // Remy Intro Panel minimize listener
  const btnMinimizeRemy = document.getElementById('btn-minimize-remy');
  const remyIntroPanel = document.getElementById('remy-intro-panel');
  if (btnMinimizeRemy && remyIntroPanel) {
    btnMinimizeRemy.addEventListener('click', () => {
      remyIntroPanel.classList.add('minimized');
      setTimeout(() => {
        remyIntroPanel.style.display = 'none';
      }, 220);
    });
  }
  // Flip X-Axis handler (controls vertical orientation flip via rotation to avoid negative scaling glitches in GGS)
  if (dom.btnFlipX) {
    dom.btnFlipX.addEventListener('click', () => {
      if (!state.isModelLoaded) {
        showToast('Please load a model first', 'warning');
        return;
      }
      
      // Toggle orientation state
      state.xFlipped = !state.xFlipped;
      const rotationX = state.xFlipped ? 0 : Math.PI;
      
      // Rotate Particle System points (180 degrees around X-axis)
      if (state.particleSystem && state.particleSystem.points) {
        state.particleSystem.points.rotation.x = rotationX;
      }
      
      // Rotate SplatMesh and correct its position translation vector to match
      if (state.splatMesh) {
        state.splatMesh.rotation.x = rotationX;
        
        const scale = state.modelScale;
        const center = state.modelCenter;
        if (center) {
          if (rotationX === 0) {
            state.splatMesh.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
          } else {
            state.splatMesh.position.set(-center.x * scale, center.y * scale, center.z * scale);
          }
        }
      }
      
      showToast(state.xFlipped ? 'Model inverted vertically' : 'Model orientation restored', 'success');
    });
  }
  // Language switcher handler
  if (dom.btnLang) {
    dom.btnLang.addEventListener('click', () => {
      state.lang = state.lang === 'zh' ? 'en' : 'zh';
      localStorage.setItem('splat-lang', state.lang);
      applyTranslations(state.lang);
    });
  }
  dom.btnHome?.addEventListener('click', () => {
    history.replaceState(null, '', window.location.pathname + window.location.search);
    window.location.reload();
  });
  // Settings range displays
  dom.settingMinOpacity.addEventListener('input', (e) => {
    dom.settingMinOpacityVal.textContent = parseFloat(e.target.value).toFixed(2);
  });
  dom.settingPointSize.addEventListener('input', (e) => {
    const size = parseFloat(e.target.value);
    dom.settingPointSizeVal.textContent = size.toFixed(2);
    state.settings.pointSize = size;
    // Dynamically update point size if model is loaded!
    if (state.isModelLoaded && state.particleSystem) {
      state.particleSystem.setPointSize(size);
    }
  });
  dom.settingPointDensity.addEventListener('input', (e) => {
    const density = parseFloat(e.target.value);
    dom.settingPointDensityVal.textContent = Math.round(density * 100) + '%';
    state.settings.pointDensity = density;
    // Dynamically update point density if model is loaded!
    if (state.isModelLoaded && state.particleSystem) {
      state.particleSystem.setDensity(density);
    }
  });
  dom.settingParticleBrightness.addEventListener('input', (e) => {
    const brightness = parseFloat(e.target.value);
    dom.settingParticleBrightnessVal.textContent = brightness.toFixed(2);
    state.settings.particleBrightness = brightness;
    // Dynamically update particle brightness if model is loaded!
    if (state.isModelLoaded && state.particleSystem) {
      state.particleSystem.setParticleBrightness(brightness);
    }
  });
  dom.settingParticleSoftness.addEventListener('input', (e) => {
    const softness = parseFloat(e.target.value);
    dom.settingParticleSoftnessVal.textContent = softness.toFixed(2);
    state.settings.particleSoftness = softness;
    // Dynamically update particle softness if model is loaded!
    if (state.isModelLoaded && state.particleSystem) {
      state.particleSystem.setParticleSoftness(softness);
    }
  });
  dom.settingParticleOpacity.addEventListener('input', (e) => {
    const opacity = parseFloat(e.target.value);
    dom.settingParticleOpacityVal.textContent = opacity.toFixed(2);
    state.settings.particleOpacity = opacity;
    // Dynamically update particle opacity if model is loaded!
    if (state.isModelLoaded && state.particleSystem) {
      state.particleSystem.setParticleOpacity(opacity);
    }
  });
  dom.settingSplatScale.addEventListener('input', (e) => {
    const scale = parseFloat(e.target.value);
    dom.settingSplatScaleVal.textContent = scale.toFixed(1);
    state.settings.splatScale = scale;
    // Dynamically update splat scale for both systems if model is loaded!
    if (state.isModelLoaded) {
      if (state.particleSystem) {
        state.particleSystem.setSplatScale(scale);
        if (state.particleSystem.pivot) {
          state.particleSystem.pivot.scale.setScalar(scale);
        }
      }
      if (state.splatMesh) {
        state.splatMesh.scale.setScalar(state.modelScale * scale);
      }
    }
  });
  
  // Scatter Effect change handler
  dom.settingScatterEffect.addEventListener('change', (e) => {
    state.cancelScatterAnimation?.();
    if (e.target.value === 'none') {
      state.settings.particleEffectEnabled = false;
      state.particleSystem?.setProgressImmediate(0);
      dom.progressSlider.value = 0;
      dom.progressValue.textContent = '0%';
      return;
    }
    state.settings.particleEffectEnabled = true;
    const effectIndex = parseFloat(e.target.value);
    state.settings.scatterEffect = effectIndex;
    if (state.isModelLoaded && state.particleSystem) {
      state.particleSystem.setScatterEffect(effectIndex);
      // Auto-play the scatter effect to demonstrate it (full cycle: 0 -> 100 -> 0)
      state.particleSystem.setProgressImmediate(0.0);
      dom.progressSlider.value = 0;
      dom.progressValue.textContent = '0%';
      scatterDirection = 'forward';
      playFullDemoScatterAnimation();
    }
  });
  // Crop factor range slider - continuous input for display, change event for reload
  if (dom.settingCropFactor) {
    dom.settingCropFactor.addEventListener('input', (e) => {
      const factor = parseFloat(e.target.value);
      dom.settingCropFactorVal.textContent = factor >= 3.0 ? (state.lang === 'zh' ? '不缩放' : 'Off') : factor.toFixed(2) + 'x';
    });
    
    dom.settingCropFactor.addEventListener('change', async (e) => {
      const factor = parseFloat(e.target.value);
      if (factor >= 3.0) {
        state.settings.cropOutliers = false;
        state.settings.cropFactor = 3.0;
      } else {
        state.settings.cropOutliers = true;
        state.settings.cropFactor = factor;
      }
      
      // Update displayed value to represent the stored value
      dom.settingCropFactorVal.textContent = factor >= 3.0 ? (state.lang === 'zh' ? '不缩放' : 'Off') : factor.toFixed(2) + 'x';
      
      // Immediately reload model with the new crop settings
      if (state.lastLoadedBuffer) {
        showLoading('Reloading...');
        setTimeout(async () => {
          try {
            await processBuffer(state.lastLoadedBuffer, state.lastLoadedName);
          } catch (err) {
            hideLoading();
            showToast(`Error: ${err.message}`, 'error');
          }
        }, 50);
      }
    });
  }
  
  // Prevent webpage zoom/scroll during flight preview
  window.addEventListener('wheel', (e) => {
    if (state.previewActive || state.recordingActive) {
      e.preventDefault();
    }
  }, { passive: false });
  
  window.addEventListener('touchmove', (e) => {
    if ((state.previewActive || state.recordingActive) && e.touches.length > 1) {
      e.preventDefault();
    }
  }, { passive: false });
}
// ============================================================
// Initialize App
// ============================================================
function init() {
  cacheDom();
  syncResponsiveControlLayout();
  applyTranslations(state.lang);
  initThreeJS();
  setupEventListeners();
  updateRendererUI();
  animate();
  
  // Update Remy panel position on startup
  if (typeof updateRemyPosition === 'function') {
    updateRemyPosition();
  }
  
  // Pre-fill URL from hash
  const hash = window.location.hash.slice(1);
  if (hash && hash.startsWith('http')) {
    dom.urlInput.value = decodeURIComponent(hash);
  }
  console.log(
    '%c✨ Particle Model Viewer Ready',
    'color: #00f5d4; font-size: 14px; font-weight: bold;'
  );
}
// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
