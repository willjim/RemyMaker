/**
 * Main Application
 * Orchestrates Three.js scene, PLY loading, particle system, and gesture control.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parsePLY, parseSplat } from './plyParser.js';
import { ParticleSystem } from './particleSystem.js?v=3.6';
import { GestureControl } from './gestureControl.js?v=1.1';
import { extractPLYFromUrl, downloadPLY } from './remyLoader.js?v=1.1';
import fixWebmDuration from 'fix-webm-duration';
import { LandingBackground } from './landingBackground.js';

const MAX_INTERACTIVE_PIXEL_RATIO = 1.5;
const RENDERER_VISIBILITY_EPSILON = 0.002;

function getInitialLanguage() {
  try {
    return localStorage.getItem('splat-lang') === 'en' ? 'en' : 'zh';
  } catch (_) {
    return 'zh';
  }
}

function detectTabletDevice({
  userAgent = navigator.userAgent || '',
  platform = navigator.platform || '',
  maxTouchPoints = navigator.maxTouchPoints || 0,
  viewportWidth = window.innerWidth,
  viewportHeight = window.innerHeight,
  coarsePointer = window.matchMedia('(pointer: coarse)').matches,
} = {}) {
  const isModernIPad = platform === 'MacIntel' && maxTouchPoints > 1;
  const isIPad = /iPad/i.test(userAgent) || isModernIPad;
  const isAndroidTablet = /Android/i.test(userAgent) && !/Mobile/i.test(userAgent);
  const isKnownTablet = /Tablet|PlayBook|Silk|Kindle|Nexus 7|Nexus 9|Pixel C|SM-T\d|Lenovo TB-/i.test(userAgent);
  const shortViewportSide = Math.min(viewportWidth, viewportHeight);
  const longViewportSide = Math.max(viewportWidth, viewportHeight);
  const isTabletSizedTouch = coarsePointer && shortViewportSide >= 600 && longViewportSide >= 700;
  return isIPad || isAndroidTablet || isKnownTablet || isTabletSizedTouch;
}

const IS_TABLET_DEVICE = detectTabletDevice();
const IS_PHONE_DEVICE = !IS_TABLET_DEVICE && /Android.*Mobile|iPhone|iPod|Windows Phone|IEMobile|Opera Mini|Mobile Safari/i.test(
  navigator.userAgent || ''
);

function applyTabletDesktopLayout() {
  if (!IS_TABLET_DEVICE) return;
  document.documentElement.classList.add('tablet-desktop-layout');
  document.body.classList.add('tablet-desktop-layout');
  const mediaRuleType = globalThis.CSSRule?.MEDIA_RULE ?? 4;

  // Mobile rules intentionally include `(pointer: coarse)` for phones in
  // landscape. Disable only those coarse-pointer rule groups on tablets so
  // the regular responsive desktop toolbar and panels remain active.
  for (const styleSheet of Array.from(document.styleSheets)) {
    let rules;
    try {
      rules = styleSheet.cssRules;
    } catch (_) {
      continue;
    }
    for (const rule of Array.from(rules || [])) {
      if (rule.type === mediaRuleType && rule.media.mediaText.includes('pointer: coarse')) {
        rule.media.mediaText = 'not all';
      }
    }
  }
}
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
  splatCropEdit: null,
  splatCropSdf: null,
  splatCropHelper: null,
  splatCropHandles: null,
  splatCropDrag: null,
  splatEraser: null,
  subjectCropBounds: null,
  sparkCropApi: null,
  sparkPainterApi: null,
  lang: getInitialLanguage(), // default to Chinese unless English was explicitly selected
  isModelLoaded: false,
  isGestureActive: false,
  rotationPaused: false,
  manualControl: false,     // true when user drags the slider
  splatInterpolation: 0.0,   // default starts fully at Particle Cloud (0.0)
  splatInterpolationTarget: 0.0,
  sparkPrewarmActive: false,
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
  keyframes: [],            // full camera snapshots used by custom paths and viewpoint recall
  selectedKeyframeIndex: null,
  cameraKeyframeTimes: null,
  cameraSphericalPoints: null,
  cameraSphericalVelocities: null,
  cameraFilteredTargets: null,
  cameraTargetVelocities: null,
  cameraProjectionValues: null,
  cameraProjectionVelocities: null,
  cameraQuaternions: null,
  cameraQuaternionControls: null,
  cameraModelQuaternions: null,
  cameraModelQuaternionControls: null,
  cameraMotionProgress: null,
  cameraMotionDistances: null,
  cameraMotionTotal: 0,
  cameraModeActive: false,  // true when camera path panel is visible
  previewActive: false,     // true during flight preview
  previewTime: 0.0,
  previewStart: null,
  cameraPathFirstFrame: null,
  restoreCameraPathFirstFrameOnOpen: false,
  previewCompleted: false,
  previewInitialRenderer: null,
  previewRendererTimeline: [],
  lastFlightGatherPercent: -1,
  gatherAnimationId: null,
  cancelScatterAnimation: null,
  recordingActive: false,   // true during flight recording
  exportPreparing: false,   // true while the export canvas/recorder is being configured
  compositingActive: false, // true while WebCodecs owns the WebGL renderer
  compositionCancelRequested: false,
  activeWebCodecsOutput: null,
  animationFrameId: null,
  exportInitialRenderer: null,
  exportRendererTimeline: [],
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
    splatCropEnabled: false,
    splatCropShape: 'ellipsoid',
    splatCropRadiiScale: { x: 1, y: 1, z: 1 },
    splatCropOffset: { x: 0, y: 0, z: 0 },
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

function getSortedQuantile(sortedValues, quantile) {
  if (!sortedValues.length) return 0;
  const index = Math.max(0, Math.min(
    sortedValues.length - 1,
    Math.round((sortedValues.length - 1) * quantile)
  ));
  return sortedValues[index];
}

/**
 * Estimate an axis-aligned subject ellipsoid from a bounded sample of visible
 * splat centers. The two-pass robust-distance trim prevents a small number of
 * remote scene splats from stretching the crop volume around the background.
 */
function estimateSubjectEllipsoid(positions) {
  const pointCount = Math.floor((positions?.length || 0) / 3);
  if (!pointCount) {
    return {
      center: new THREE.Vector3(),
      radii: new THREE.Vector3(1, 1, 1),
      sampleCount: 0,
    };
  }

  const maxSamples = 24000;
  const sampleCount = Math.min(pointCount, maxSamples);
  const step = pointCount / sampleCount;
  const samples = [];
  const axes = [[], [], []];

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const pointIndex = Math.min(pointCount - 1, Math.floor(sampleIndex * step));
    const offset = pointIndex * 3;
    const x = positions[offset];
    const y = positions[offset + 1];
    const z = positions[offset + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    samples.push({ x, y, z });
    axes[0].push(x);
    axes[1].push(y);
    axes[2].push(z);
  }

  if (!samples.length) {
    return {
      center: new THREE.Vector3(),
      radii: new THREE.Vector3(1, 1, 1),
      sampleCount: 0,
    };
  }

  axes.forEach(axis => axis.sort((a, b) => a - b));
  const firstCenter = new THREE.Vector3(
    getSortedQuantile(axes[0], 0.5),
    getSortedQuantile(axes[1], 0.5),
    getSortedQuantile(axes[2], 0.5)
  );
  const deviations = [[], [], []];
  for (const sample of samples) {
    deviations[0].push(Math.abs(sample.x - firstCenter.x));
    deviations[1].push(Math.abs(sample.y - firstCenter.y));
    deviations[2].push(Math.abs(sample.z - firstCenter.z));
  }
  deviations.forEach(axis => axis.sort((a, b) => a - b));
  const robustScale = new THREE.Vector3(
    Math.max(getSortedQuantile(deviations[0], 0.5), 1e-5),
    Math.max(getSortedQuantile(deviations[1], 0.5), 1e-5),
    Math.max(getSortedQuantile(deviations[2], 0.5), 1e-5)
  );

  const scoredSamples = samples.map(sample => {
    const dx = (sample.x - firstCenter.x) / robustScale.x;
    const dy = (sample.y - firstCenter.y) / robustScale.y;
    const dz = (sample.z - firstCenter.z) / robustScale.z;
    return { sample, distance: Math.hypot(dx, dy, dz) };
  }).sort((a, b) => a.distance - b.distance);
  const coreLimit = getSortedQuantile(scoredSamples.map(item => item.distance), 0.78);
  const coreSamples = scoredSamples
    .filter(item => item.distance <= coreLimit)
    .map(item => item.sample);
  const subjectSamples = coreSamples.length >= 16 ? coreSamples : samples;
  const subjectAxes = [[], [], []];
  for (const sample of subjectSamples) {
    subjectAxes[0].push(sample.x);
    subjectAxes[1].push(sample.y);
    subjectAxes[2].push(sample.z);
  }
  subjectAxes.forEach(axis => axis.sort((a, b) => a - b));
  const center = new THREE.Vector3(
    getSortedQuantile(subjectAxes[0], 0.5),
    getSortedQuantile(subjectAxes[1], 0.5),
    getSortedQuantile(subjectAxes[2], 0.5)
  );
  const subjectDeviations = [[], [], []];
  for (const sample of subjectSamples) {
    subjectDeviations[0].push(Math.abs(sample.x - center.x));
    subjectDeviations[1].push(Math.abs(sample.y - center.y));
    subjectDeviations[2].push(Math.abs(sample.z - center.z));
  }
  subjectDeviations.forEach(axis => axis.sort((a, b) => a - b));

  const radii = new THREE.Vector3(
    getSortedQuantile(subjectDeviations[0], 0.99) * 1.14,
    getSortedQuantile(subjectDeviations[1], 0.99) * 1.14,
    getSortedQuantile(subjectDeviations[2], 0.99) * 1.14
  );
  const longestRadius = Math.max(radii.x, radii.y, radii.z, 1e-3);
  const minimumRadius = longestRadius * 0.08;
  radii.set(
    Math.max(radii.x, minimumRadius),
    Math.max(radii.y, minimumRadius),
    Math.max(radii.z, minimumRadius)
  );

  return { center, radii, sampleCount: samples.length };
}

function analyzeParticleCropBounds(positions, count) {
  const safeCount = Math.min(count || 0, Math.floor((positions?.length || 0) / 3));
  if (!positions || safeCount <= 0) {
    return {
      center: { x: 0, y: 0, z: 0 },
      radius: 0,
      recommendedFactor: 2.5,
    };
  }

  const sampleLimit = Math.min(10000, safeCount);
  const sampleStep = Math.max(1, Math.floor(safeCount / sampleLimit));
  const samples = [];
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;

  for (let i = 0; i < safeCount && samples.length < sampleLimit; i += sampleStep) {
    const offset = i * 3;
    const x = positions[offset];
    const y = positions[offset + 1];
    const z = positions[offset + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    samples.push([x, y, z]);
    sumX += x;
    sumY += y;
    sumZ += z;
  }

  if (samples.length === 0) {
    return {
      center: { x: 0, y: 0, z: 0 },
      radius: 0,
      recommendedFactor: 2.5,
    };
  }

  const center = {
    x: sumX / samples.length,
    y: sumY / samples.length,
    z: sumZ / samples.length,
  };
  const distances = samples
    .map(([x, y, z]) => Math.hypot(x - center.x, y - center.y, z - center.z))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (distances.length === 0) {
    return { center, radius: 0, recommendedFactor: 2.5 };
  }

  const radius = distances[Math.floor(distances.length * 0.5)];
  if (!(radius > 0)) {
    return { center, radius: 0, recommendedFactor: 2.5 };
  }

  let farCount = 0;
  let sumSqDiff = 0;
  for (const distance of distances) {
    sumSqDiff += (distance - radius) ** 2;
    if (distance > radius * 1.8) farCount++;
  }
  const coefficientOfVariation = Math.sqrt(sumSqDiff / distances.length) / radius;
  const farRatio = farCount / distances.length;
  let recommendedFactor = 2.5;
  if (coefficientOfVariation > 0.8) {
    recommendedFactor = farRatio < 0.05 ? 1.5 : (farRatio < 0.12 ? 2.0 : 3.0);
  }

  return { center, radius, recommendedFactor };
}

function isSplatCropEnabled() {
  return state.settings.splatCropEnabled;
}

function updateCropToggleUI(button, enabled, mode) {
  if (!button) return;
  const isParticle = mode === 'particle';
  const modeName = state.lang === 'zh'
    ? (isParticle ? '粒子裁剪' : '3DGS 裁剪')
    : (isParticle ? 'Particle crop' : '3DGS crop');
  button.classList.toggle('active', enabled);
  button.setAttribute('aria-pressed', String(enabled));
  button.setAttribute(
    'aria-label',
    state.lang === 'zh'
      ? `${enabled ? '关闭' : '打开'}${modeName}`
      : `${enabled ? 'Disable' : 'Enable'} ${modeName}`
  );
  button.title = state.lang === 'zh'
    ? `${modeName}：${enabled ? '开启' : '关闭'}`
    : `${modeName}: ${enabled ? 'On' : 'Off'}`;
}

function normalizeSplatCropShape(shape) {
  return shape === 'box' ? 'box' : 'ellipsoid';
}

function updateSplatCropShapeUI() {
  const shape = normalizeSplatCropShape(state.settings.splatCropShape);
  const cropDisabled = !state.settings.splatCropEnabled;
  const buttons = [
    [dom.btnSplatCropShapeEllipsoid, 'ellipsoid'],
    [dom.btnSplatCropShapeBox, 'box'],
  ];
  for (const [button, buttonShape] of buttons) {
    if (!button) continue;
    const selected = buttonShape === shape && !cropDisabled;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  if (dom.btnMobileSplatCropNone) {
    dom.btnMobileSplatCropNone.classList.toggle('active', cropDisabled);
    dom.btnMobileSplatCropNone.setAttribute('aria-pressed', String(cropDisabled));
  }
}

function disposeObject3DResources(root) {
  if (!root) return;
  const geometries = new Set();
  const materials = new Set();
  root.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of objectMaterials) {
      if (material) materials.add(material);
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

function createEllipsoidCropGuideGeometry() {
  const positions = [];
  const longitudeCount = 12;
  const latitudeRingCount = 6;
  // These subdivisions smooth each curve; they do not add visible grid lines.
  const meridianCurveSegments = 32;
  const latitudeCurveSegments = 48;
  const addPoint = (phi, theta) => {
    const sinPhi = Math.sin(phi);
    positions.push(
      sinPhi * Math.cos(theta),
      Math.cos(phi),
      sinPhi * Math.sin(theta)
    );
  };

  for (let longitude = 0; longitude < longitudeCount; longitude += 1) {
    const theta = (longitude / longitudeCount) * Math.PI * 2;
    for (let segment = 0; segment < meridianCurveSegments; segment += 1) {
      addPoint((segment / meridianCurveSegments) * Math.PI, theta);
      addPoint(((segment + 1) / meridianCurveSegments) * Math.PI, theta);
    }
  }

  for (let latitude = 1; latitude <= latitudeRingCount; latitude += 1) {
    const phi = (latitude / (latitudeRingCount + 1)) * Math.PI;
    for (let segment = 0; segment < latitudeCurveSegments; segment += 1) {
      addPoint(phi, (segment / latitudeCurveSegments) * Math.PI * 2);
      addPoint(phi, ((segment + 1) / latitudeCurveSegments) * Math.PI * 2);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([...positions], 3));
  return geometry;
}

function createBoxCropGuideGeometry() {
  const surfaceGeometry = new THREE.BoxGeometry(2, 2, 2);
  const geometry = new THREE.EdgesGeometry(surfaceGeometry);
  surfaceGeometry.dispose();
  const positions = geometry.getAttribute('position');
  const normals = new Float32Array(positions.count * 3);

  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const inverseLength = 1 / Math.hypot(x, y, z);
    normals[index * 3] = x * inverseLength;
    normals[index * 3 + 1] = y * inverseLength;
    normals[index * 3 + 2] = z * inverseLength;
  }

  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return geometry;
}

function createBoxCropDiagonalGeometry() {
  const positions = [
    -1, -1, -1, -1, 1, 1,
     1, -1, -1,  1, 1, 1,
    -1, -1, -1,  1, -1, 1,
    -1,  1, -1,  1, 1, 1,
    -1, -1, -1,  1, 1, -1,
    -1, -1,  1,  1, 1, 1,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(
    positions.map(value => value / Math.sqrt(3)),
    3
  ));
  return geometry;
}

function createDepthCuedCropGuideMaterial(nearOpacity = 0.82, farOpacity = 0.32) {
  return new THREE.ShaderMaterial({
    uniforms: {
      guideColor: { value: new THREE.Color(0x00a8ff) },
      nearOpacity: { value: nearOpacity },
      farOpacity: { value: farOpacity },
    },
    vertexShader: /* glsl */ `
      varying float vFacing;

      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vec3 viewNormal = normalize(normalMatrix * normal);
        vec3 viewDirection = normalize(-viewPosition.xyz);
        vFacing = dot(viewNormal, viewDirection);
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 guideColor;
      uniform float nearOpacity;
      uniform float farOpacity;
      varying float vFacing;

      void main() {
        float facingBlend = smoothstep(-0.06, 0.06, vFacing);
        gl_FragColor = vec4(guideColor, mix(farOpacity, nearOpacity, facingBlend));
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

function createSplatCropHelper(shape) {
  const normalizedShape = normalizeSplatCropShape(shape);
  const helper = new THREE.Group();
  const guideLines = new THREE.LineSegments(
    normalizedShape === 'ellipsoid'
      ? createEllipsoidCropGuideGeometry()
      : createBoxCropGuideGeometry(),
    createDepthCuedCropGuideMaterial()
  );
  guideLines.name = normalizedShape === 'ellipsoid'
    ? '3DGS Crop Ellipsoid Guide'
    : '3DGS Crop Box Guide';
  guideLines.renderOrder = 9999;
  helper.add(guideLines);
  if (normalizedShape === 'box') {
    const diagonalLines = new THREE.LineSegments(
      createBoxCropDiagonalGeometry(),
      createDepthCuedCropGuideMaterial(0.28, 0.11)
    );
    diagonalLines.name = '3DGS Crop Box Face Diagonals';
    diagonalLines.renderOrder = 9998;
    helper.add(diagonalLines);
  }
  helper.name = normalizedShape === 'box'
    ? '3DGS Subject Crop Box'
    : '3DGS Subject Crop Ellipsoid';
  helper.userData.cropShape = normalizedShape;
  return helper;
}

const SPLAT_CROP_AXIS_COLORS = {
  x: 0xff5365,
  y: 0x3dc76f,
  z: 0x347eff,
};

function createSplatCropHandles(bounds) {
  const handles = new THREE.Group();
  handles.name = '3DGS Crop Face Handles';
  const handleLength = Math.max(bounds.radii.x, bounds.radii.y, bounds.radii.z, 1e-3) * 0.2;
  const shaftLength = handleLength * 0.58;
  const coneLength = handleLength * 0.34;
  const shaftRadius = handleLength * 0.055;
  const coneRadius = handleLength * 0.15;
  const defaultDirection = new THREE.Vector3(0, 1, 0);

  for (const axis of ['x', 'y', 'z']) {
    for (const sign of [-1, 1]) {
      const direction = new THREE.Vector3(
        axis === 'x' ? sign : 0,
        axis === 'y' ? sign : 0,
        axis === 'z' ? sign : 0
      );
      const handle = new THREE.Group();
      handle.name = `3DGS Crop ${axis.toUpperCase()} ${sign > 0 ? 'Positive' : 'Negative'} Handle`;
      handle.userData.cropHandle = { axis, sign };
      handle.quaternion.setFromUnitVectors(defaultDirection, direction);

      const material = new THREE.MeshBasicMaterial({
        color: SPLAT_CROP_AXIS_COLORS[axis],
        transparent: true,
        opacity: 0.96,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 12),
        material
      );
      shaft.position.y = shaftLength * 0.5;
      shaft.renderOrder = 10002;

      const head = new THREE.Mesh(
        new THREE.ConeGeometry(coneRadius, coneLength, 16),
        material
      );
      head.position.y = shaftLength + coneLength * 0.5;
      head.renderOrder = 10002;
      // Only the visible shaft and cone participate in raycasting so the
      // surrounding empty area cannot accidentally start a crop drag.
      handle.add(shaft, head);
      handles.add(handle);
    }
  }
  return handles;
}

function updateSplatCropHandlePositions(cropCenter, cropRadii) {
  if (!state.splatCropHandles) return;
  for (const handle of state.splatCropHandles.children) {
    const { axis, sign } = handle.userData.cropHandle || {};
    if (!axis || !sign) continue;
    handle.position.copy(cropCenter);
    handle.position[axis] += cropRadii[axis] * sign;
  }
  state.splatCropHandles.updateMatrixWorld(true);
}

function updateSplatCropHandleDepthOpacity() {
  const handles = state.splatCropHandles;
  if (!handles?.visible || !state.camera) return;
  state.camera.updateMatrixWorld(true);
  handles.updateWorldMatrix(true, true);
  const samples = handles.children.map((handle) => {
    const worldPosition = handle.getWorldPosition(new THREE.Vector3());
    const viewPosition = worldPosition.applyMatrix4(state.camera.matrixWorldInverse);
    return { handle, depth: Math.max(0, -viewPosition.z) };
  });
  if (!samples.length) return;
  const minDepth = Math.min(...samples.map(sample => sample.depth));
  const maxDepth = Math.max(...samples.map(sample => sample.depth));
  const depthSpan = Math.max(maxDepth - minDepth, 1e-5);

  for (const { handle, depth } of samples) {
    const depthRatio = THREE.MathUtils.clamp((depth - minDepth) / depthSpan, 0, 1);
    const opacity = THREE.MathUtils.lerp(0.96, 0.3, depthRatio);
    handle.traverse((object) => {
      if (object.material) object.material.opacity = opacity;
    });
  }
}

function createSplatCropSdf(shape) {
  const { SplatEditSdf, SplatEditSdfType } = state.sparkCropApi || {};
  if (!SplatEditSdf || !SplatEditSdfType) return null;
  const normalizedShape = normalizeSplatCropShape(shape);
  return new SplatEditSdf({
    type: normalizedShape === 'box' ? SplatEditSdfType.BOX : SplatEditSdfType.ELLIPSOID,
    invert: true,
    opacity: 0,
    color: new THREE.Color(1, 1, 1),
    displace: new THREE.Vector3(0, 0, 0),
  });
}

function replaceSplatCropHelper() {
  if (!state.splatMesh) return;
  if (state.splatCropHelper) {
    state.splatCropHelper.removeFromParent();
    disposeObject3DResources(state.splatCropHelper);
  }
  state.splatCropHelper = createSplatCropHelper(state.settings.splatCropShape);
  state.splatMesh.add(state.splatCropHelper);
}

function applySplatCropShape(shape) {
  const normalizedShape = normalizeSplatCropShape(shape);
  state.settings.splatCropShape = normalizedShape;
  updateSplatCropShapeUI();
  if (!state.splatCropEdit || !state.splatMesh) return;

  state.splatCropSdf?.removeFromParent();
  const nextSdf = createSplatCropSdf(normalizedShape);
  if (!nextSdf) return;
  state.splatCropEdit.add(nextSdf);
  state.splatCropSdf = nextSdf;
  replaceSplatCropHelper();
  state.splatMesh.updateGenerator?.();
  updateSplatCropFromSettings();
}

function disposeSplatCrop() {
  if (state.splatCropHelper) {
    state.splatCropHelper.removeFromParent();
    disposeObject3DResources(state.splatCropHelper);
  }
  if (state.splatCropHandles) {
    state.splatCropHandles.removeFromParent();
    disposeObject3DResources(state.splatCropHandles);
  }
  state.splatCropEdit?.removeFromParent();
  endSplatCropDrag();
  state.splatCropHelper = null;
  state.splatCropHandles = null;
  state.splatCropEdit = null;
  state.splatCropSdf = null;
}

function syncSplatCropHelperVisibility() {
  const settingsVisible = dom.settingsPanel && !dom.settingsPanel.classList.contains('hidden');
  const mobileCropEditorVisible = !isMobileViewport() || Boolean(
    dom.settingsPanel?.classList.contains('mobile-settings-detail')
    && dom.settingsPanel?.classList.contains('mobile-settings-spark')
    && dom.settingsPanel?.classList.contains('mobile-splat-crop-view')
  );
  const visible = Boolean(
    isSplatCropEnabled()
    && settingsVisible
    && mobileCropEditorVisible
    && state.settings.renderer === 'spark'
    && !state.splatEraser?.active
    && !state.previewActive
    && !state.recordingActive
    && !state.compositingActive
  );
  if (state.splatCropHelper) state.splatCropHelper.visible = visible;
  if (state.splatCropHandles) state.splatCropHandles.visible = visible;
  if (!visible && state.renderer?.domElement && !state.splatCropDrag) {
    state.renderer.domElement.style.cursor = '';
  }
}

function updateSplatCropFromSettings() {
  const bounds = state.subjectCropBounds;
  if (!bounds || !state.splatCropEdit || !state.splatCropSdf) return;
  const enabled = isSplatCropEnabled();
  const radiiScale = state.settings.splatCropRadiiScale;
  const cropRadii = bounds.radii.clone().multiply(new THREE.Vector3(
    THREE.MathUtils.clamp(radiiScale.x, 0.1, 10),
    THREE.MathUtils.clamp(radiiScale.y, 0.1, 10),
    THREE.MathUtils.clamp(radiiScale.z, 0.1, 10)
  ));
  const offset = state.settings.splatCropOffset;
  const cropCenter = bounds.center.clone().add(new THREE.Vector3(
    bounds.radii.x * offset.x,
    bounds.radii.y * offset.y,
    bounds.radii.z * offset.z
  ));

  state.splatCropEdit.visible = enabled;
  state.splatCropSdf.position.copy(cropCenter);
  state.splatCropSdf.scale.copy(cropRadii);
  state.splatCropSdf.updateMatrixWorld(true);

  if (state.splatCropHelper) {
    state.splatCropHelper.position.copy(cropCenter);
    state.splatCropHelper.scale.copy(cropRadii);
    state.splatCropHelper.updateMatrixWorld(true);
  }
  updateSplatCropHandlePositions(cropCenter, cropRadii);
  syncSplatCropHelperVisibility();
}

function configureSplatCrop(mesh, data) {
  const {
    SplatEdit,
    SplatEditSdf,
    SplatEditSdfType,
    SplatEditRgbaBlendMode,
  } = state.sparkCropApi || {};
  if (!SplatEdit || !SplatEditSdf || !SplatEditSdfType || !SplatEditRgbaBlendMode) {
    console.warn('Spark SplatEdit is unavailable; 3DGS background crop was not applied.');
    return;
  }

  if (!state.subjectCropBounds) {
    state.subjectCropBounds = estimateSubjectEllipsoid(data.positions);
    console.log('[3DGS Subject Crop]', {
      center: state.subjectCropBounds.center.toArray(),
      radii: state.subjectCropBounds.radii.toArray(),
      sampleCount: state.subjectCropBounds.sampleCount,
    });
  }

  const cropEdit = new SplatEdit({
    name: 'RemyMaker Subject Crop',
    rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY,
    sdfSmooth: 0,
    softEdge: 0,
  });
  const cropSdf = createSplatCropSdf(state.settings.splatCropShape);
  if (!cropSdf) return;
  cropEdit.add(cropSdf);
  mesh.add(cropEdit);

  const helper = createSplatCropHelper(state.settings.splatCropShape);
  mesh.add(helper);
  const handles = createSplatCropHandles(state.subjectCropBounds);
  mesh.add(handles);

  state.splatCropEdit = cropEdit;
  state.splatCropSdf = cropSdf;
  state.splatCropHelper = helper;
  state.splatCropHandles = handles;
  updateSplatCropFromSettings();
}

const splatCropRaycaster = new THREE.Raycaster();
const splatCropPointer = new THREE.Vector2();

function getSplatCropHandleFromObject(object) {
  let current = object;
  while (current && current !== state.splatCropHandles) {
    if (current.userData?.cropHandle) return current;
    current = current.parent;
  }
  return null;
}

function getSplatCropHandleAtPointer(event) {
  const canvas = state.renderer?.domElement;
  if (!canvas || !state.camera || !state.splatCropHandles?.visible) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  splatCropPointer.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  state.scene?.updateMatrixWorld(true);
  state.camera.updateMatrixWorld(true);
  splatCropRaycaster.setFromCamera(splatCropPointer, state.camera);
  const intersections = splatCropRaycaster.intersectObjects(state.splatCropHandles.children, true);
  return intersections.length ? getSplatCropHandleFromObject(intersections[0].object) : null;
}

function vectorToCanvasPoint(vector, rect) {
  const projected = vector.clone().project(state.camera);
  return {
    x: rect.left + (projected.x + 1) * 0.5 * rect.width,
    y: rect.top + (1 - (projected.y + 1) * 0.5) * rect.height,
  };
}

function beginSplatCropDrag(event) {
  if (state.splatEraser?.active) return;
  if (event.button !== undefined && event.button !== 0) return;
  if (!event.isPrimary) return;
  const handle = getSplatCropHandleAtPointer(event);
  if (!handle || !state.subjectCropBounds || !state.splatMesh) return;

  const { axis, sign } = handle.userData.cropHandle;
  const bounds = state.subjectCropBounds;
  const radiiScale = state.settings.splatCropRadiiScale;
  const startRadii = bounds.radii.clone().multiply(new THREE.Vector3(
    radiiScale.x,
    radiiScale.y,
    radiiScale.z
  ));
  const startCenter = bounds.center.clone().add(new THREE.Vector3(
    bounds.radii.x * state.settings.splatCropOffset.x,
    bounds.radii.y * state.settings.splatCropOffset.y,
    bounds.radii.z * state.settings.splatCropOffset.z
  ));
  const rect = state.renderer.domElement.getBoundingClientRect();
  const centerWorld = state.splatMesh.localToWorld(startCenter.clone());
  const faceLocal = startCenter.clone();
  faceLocal[axis] += startRadii[axis] * sign;
  const faceWorld = state.splatMesh.localToWorld(faceLocal);
  const centerPoint = vectorToCanvasPoint(centerWorld, rect);
  const facePoint = vectorToCanvasPoint(faceWorld, rect);
  let directionX = facePoint.x - centerPoint.x;
  let directionY = facePoint.y - centerPoint.y;
  let projectedRadius = Math.hypot(directionX, directionY);

  if (projectedRadius < 8) {
    if (axis === 'x') {
      directionX = sign;
      directionY = 0;
    } else {
      directionX = 0;
      directionY = -sign;
    }
    projectedRadius = Math.max(72, Math.min(rect.width, rect.height) * 0.18);
  } else {
    directionX /= projectedRadius;
    directionY /= projectedRadius;
  }

  const startRadius = startRadii[axis];
  state.splatCropDrag = {
    pointerId: event.pointerId,
    axis,
    sign,
    startX: event.clientX,
    startY: event.clientY,
    directionX,
    directionY,
    localUnitsPerPixel: startRadius / projectedRadius,
    startFace: startCenter[axis] + sign * startRadius,
    oppositeFace: startCenter[axis] - sign * startRadius,
    controlsWereEnabled: state.controls?.enabled !== false,
    autoRotateWasEnabled: Boolean(state.particleSystem?.autoRotate),
  };

  if (state.controls) state.controls.enabled = false;
  if (state.particleSystem) state.particleSystem.autoRotate = false;
  state.renderer.domElement.setPointerCapture?.(event.pointerId);
  state.renderer.domElement.style.cursor = 'grabbing';
  event.preventDefault();
  event.stopImmediatePropagation();
}

function moveSplatCropDrag(event) {
  const drag = state.splatCropDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  const pixelDelta = (
    (event.clientX - drag.startX) * drag.directionX
    + (event.clientY - drag.startY) * drag.directionY
  );
  const outwardDelta = pixelDelta * drag.localUnitsPerPixel;
  const requestedFace = drag.startFace + drag.sign * outwardDelta;
  const bounds = state.subjectCropBounds;
  const baseRadius = Math.max(bounds.radii[drag.axis], 1e-6);
  const requestedRadius = drag.sign * (requestedFace - drag.oppositeFace) * 0.5;
  const nextRadius = THREE.MathUtils.clamp(requestedRadius, baseRadius * 0.1, baseRadius * 10);
  const nextFace = drag.oppositeFace + drag.sign * nextRadius * 2;
  const nextCenter = (nextFace + drag.oppositeFace) * 0.5;

  state.settings.splatCropRadiiScale[drag.axis] = nextRadius / baseRadius;
  state.settings.splatCropOffset[drag.axis] = (nextCenter - bounds.center[drag.axis]) / baseRadius;
  updateSplatCropFromSettings();
  event.preventDefault();
  event.stopImmediatePropagation();
}

function endSplatCropDrag(event) {
  const drag = state.splatCropDrag;
  if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
  const canvas = state.renderer?.domElement;
  if (canvas && drag.pointerId !== undefined && canvas.hasPointerCapture?.(drag.pointerId)) {
    canvas.releasePointerCapture(drag.pointerId);
  }
  if (state.controls) state.controls.enabled = drag.controlsWereEnabled;
  if (state.particleSystem) state.particleSystem.autoRotate = drag.autoRotateWasEnabled;
  state.splatCropDrag = null;
  if (canvas) canvas.style.cursor = '';
  event?.preventDefault?.();
  event?.stopImmediatePropagation?.();
}

function updateSplatCropHandleHover(event) {
  if (state.splatCropDrag || !state.renderer?.domElement) return;
  if (state.splatEraser?.active) {
    updateSplatEraserBrushCursor(event);
    state.renderer.domElement.style.cursor = state.splatEraser.touchLayout
      ? (state.splatEraser.navigationMode ? 'grab' : 'crosshair')
      : (event?.altKey ? 'grab' : ((event?.buttons || 0) & 6 ? 'grabbing' : 'none'));
    return;
  }
  state.renderer.domElement.style.cursor = getSplatCropHandleAtPointer(event) ? 'grab' : '';
}

function createSplatEraserModifier(eraser) {
  const { dyno } = state.sparkPainterApi;
  return dyno.dynoBlock(
    { gsplat: dyno.Gsplat },
    { gsplat: dyno.Gsplat },
    ({ gsplat }) => {
      const { center, rgb, opacity } = dyno.splitGsplat(gsplat).outputs;
      const projection = dyno.dot(
        eraser.brushDirection,
        dyno.sub(center, eraser.brushOrigin)
      );
      const projectedCenter = dyno.add(
        eraser.brushOrigin,
        dyno.mul(eraser.brushDirection, projection)
      );
      const distance = dyno.length(dyno.sub(projectedCenter, center));
      const insideBrush = dyno.and(
        dyno.lessThan(distance, eraser.brushRadius),
        dyno.and(
          dyno.greaterThan(projection, dyno.dynoFloat(0)),
          dyno.lessThan(projection, eraser.brushDepth)
        )
      );
      const isHighlighted = dyno.lessThan(
        dyno.length(dyno.sub(rgb, eraser.selectionColor)),
        dyno.dynoFloat(0.02)
      );
      const highlightedRgb = dyno.select(
        dyno.and(eraser.paintEnabled, insideBrush),
        eraser.selectionColor,
        rgb
      );
      const strokeOpacity = dyno.select(
        dyno.and(eraser.eraseEnabled, insideBrush),
        dyno.dynoFloat(0),
        opacity
      );
      const erasedOpacity = dyno.select(
        dyno.and(eraser.commitEnabled, isHighlighted),
        dyno.dynoFloat(0),
        strokeOpacity
      );
      return {
        gsplat: dyno.combineGsplat({
          gsplat,
          rgb: highlightedRgb,
          opacity: erasedOpacity,
        }),
      };
    }
  );
}

function updateSplatEraserUI() {
  const active = Boolean(state.splatEraser?.active);
  const labelKey = active ? 'btn-splat-eraser-exit' : 'btn-splat-eraser';
  const label = translations[state.lang]?.[labelKey]
    || (state.lang === 'zh' ? '高斯点擦除' : 'Erase Gaussian splats');
  if (dom.btnSplatEraser) {
    dom.btnSplatEraser.classList.toggle('active', active);
    dom.btnSplatEraser.setAttribute('aria-pressed', String(active));
    dom.btnSplatEraser.setAttribute('aria-label', label);
    dom.btnSplatEraser.title = label;
  }

  const eraser = state.splatEraser;
  const hasSelection = Boolean(eraser?.hasSelection);
  const canUndo = Boolean(eraser?.staged || eraser?.history?.length);
  const touchLayout = Boolean(eraser?.touchLayout || isMobileViewport());
  const navigationMode = Boolean(eraser?.navigationMode);
  if (dom.btnSplatEraserPaint) {
    const paintSelected = active && !navigationMode;
    dom.btnSplatEraserPaint.classList.toggle('active', paintSelected);
    dom.btnSplatEraserPaint.setAttribute('aria-pressed', String(paintSelected));
    dom.btnSplatEraserPaint.textContent = state.lang === 'zh'
      ? (touchLayout ? '涂抹' : (active ? '停止涂抹' : '涂抹选区'))
      : (touchLayout ? 'Paint' : (active ? 'Stop Painting' : 'Paint Selection'));
  }
  if (dom.btnSplatEraserConfirm) {
    dom.btnSplatEraserConfirm.disabled = !hasSelection || Boolean(eraser?.baking);
    dom.btnSplatEraserConfirm.textContent = state.lang === 'zh'
      ? (touchLayout ? '清除' : '确定擦除')
      : (touchLayout ? 'Clear' : 'Confirm Erase');
  }
  if (dom.btnSplatEraserUndo) {
    dom.btnSplatEraserUndo.disabled = !canUndo || Boolean(eraser?.baking);
    dom.btnSplatEraserUndo.textContent = state.lang === 'zh' ? '撤销' : 'Undo';
  }
  if (dom.splatEraserStatus) {
    dom.splatEraserStatus.classList.toggle('has-selection', hasSelection);
    dom.splatEraserStatus.textContent = state.lang === 'zh'
      ? (hasSelection
        ? (touchLayout ? '粉色区域待确认' : '粉色区域待确认 · [ / ] 调大小')
        : (active
          ? (navigationMode ? '拖动模型调整视角' : (touchLayout ? '在模型上拖动涂抹' : '左键涂抹 · [ / ] 调大小 · Alt/Option 旋转'))
          : '点击涂抹选区开始'))
      : (hasSelection
        ? (touchLayout ? 'Pink area ready' : 'Pink area ready · [ / ] resize')
        : (active
          ? (navigationMode ? 'Drag the model to adjust the view' : (touchLayout ? 'Drag across the model to paint' : 'Paint · [ / ] resize · Alt/Option orbit'))
          : 'Choose Paint Selection to begin'));
  }
}

function updateSplatEraserBrushDimensions(eraser) {
  if (!eraser || !state.camera || !eraser.mesh) return;
  const targetPoint = state.controls?.target || new THREE.Vector3();
  const focusDepth = Math.max(0.1, state.camera.position.distanceTo(targetPoint));
  const halfFovRad = THREE.MathUtils.degToRad(state.camera.fov * 0.5);
  const viewHeightAtDepth = 2 * focusDepth * Math.tan(halfFovRad);
  const radiusWorld = Math.max(0.001, (viewHeightAtDepth * 0.5) * eraser.brushScale);
  
  eraser.mesh.updateWorldMatrix(true, false);
  const meshScale = eraser.mesh.getWorldScale(new THREE.Vector3()).x || 1;
  eraser.brushRadius.value = radiusWorld / Math.max(1e-4, meshScale);
  eraser.brushDepth.value = Math.max(10, focusDepth * 4);
}

function setSplatEraserBrushPercent(value) {
  const slider = dom.settingSplatEraserSize;
  const minimum = parseFloat(slider?.min) || 2;
  const maximum = parseFloat(slider?.max) || 20;
  const percent = THREE.MathUtils.clamp(parseFloat(value) || 8, minimum, maximum);
  if (slider) slider.value = String(percent);
  if (dom.settingSplatEraserSizeVal) {
    dom.settingSplatEraserSizeVal.textContent = `${Math.round(percent)}%`;
  }
  if (state.splatEraser) {
    state.splatEraser.brushScale = percent / 100;
    updateSplatEraserBrushDimensions(state.splatEraser);
    syncSplatEraserBrushCursor();
  }
  showSplatEraserBrushPreview();
}

function getSplatEraserCursorDiameter(eraser) {
  const canvas = state.renderer?.domElement;
  if (!eraser || !canvas) return 24;
  const rect = canvas.getBoundingClientRect();
  if (!rect.height) return 24;

  const diameter = rect.height * eraser.brushScale;
  const maxDiameter = eraser.touchLayout
    ? Math.max(rect.width, rect.height) * 2
    : Math.min(rect.width, rect.height) * 0.9;
  return THREE.MathUtils.clamp(diameter, 12, maxDiameter);
}

function syncSplatEraserBrushCursor() {
  const eraser = state.splatEraser;
  const cursor = dom.splatEraserBrushCursor;
  if (!cursor) return;
  const visible = Boolean(
    eraser?.active
    && eraser.cursorInside
    && !eraser.cursorNavigation
    && !eraser.touchGesture
  );
  cursor.classList.toggle('visible', visible);
  if (visible) {
    const diameter = getSplatEraserCursorDiameter(eraser);
    cursor.style.left = `${eraser.cursorX}px`;
    cursor.style.top = `${eraser.cursorY}px`;
    cursor.style.width = `${diameter}px`;
    cursor.style.height = `${diameter}px`;
  }
}

function updateSplatEraserBrushCursor(event) {
  const eraser = state.splatEraser;
  const canvas = state.renderer?.domElement;
  if (!eraser?.active || !canvas || !event) {
    syncSplatEraserBrushCursor();
    return;
  }
  const rect = canvas.getBoundingClientRect();
  eraser.cursorX = event.clientX;
  eraser.cursorY = event.clientY;
  eraser.cursorInside = (
    event.clientX >= rect.left
    && event.clientX <= rect.right
    && event.clientY >= rect.top
    && event.clientY <= rect.bottom
  );
  eraser.cursorNavigation = eraser.touchLayout
    ? Boolean(eraser.touchGesture)
    : Boolean(event.altKey || ((event.buttons || 0) & 6));
  syncSplatEraserBrushCursor();
}

function showSplatEraserBrushPreview(event = null) {
  const canvas = state.renderer?.domElement;
  const cursor = dom.splatEraserBrushCursor;
  if (!canvas || !cursor) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const brushScale = (state.splatEraser?.brushScale)
    ?? ((parseFloat(dom.settingSplatEraserSize?.value) || 8) / 100);

  const diameter = rect.height * brushScale;
  const cursorX = event?.clientX ?? (rect.left + rect.width * 0.5);
  const cursorY = event?.clientY ?? (rect.top + rect.height * 0.5);

  cursor.style.left = `${cursorX}px`;
  cursor.style.top = `${cursorY}px`;
  cursor.style.width = `${diameter}px`;
  cursor.style.height = `${diameter}px`;
  cursor.classList.add('visible');

  if (state.splatEraser) {
    state.splatEraser.cursorX = cursorX;
    state.splatEraser.cursorY = cursorY;
    state.splatEraser.cursorInside = true;
    state.splatEraser.cursorNavigation = false;
    if (state.splatEraser.cursorHideTimer) clearTimeout(state.splatEraser.cursorHideTimer);
    state.splatEraser.cursorHideTimer = setTimeout(() => {
      if (state.splatEraser) state.splatEraser.cursorHideTimer = null;
      if (!state.splatEraser?.drawing && !state.splatEraser?.touchGesture) {
        hideSplatEraserBrushCursor();
      }
    }, 2000);
  } else {
    if (window._splatEraserPreviewTimer) clearTimeout(window._splatEraserPreviewTimer);
    window._splatEraserPreviewTimer = setTimeout(() => {
      cursor.classList.remove('visible');
    }, 2000);
  }
}

function hideSplatEraserBrushCursor() {
  if (state.splatEraser) {
    state.splatEraser.cursorInside = false;
    if (state.splatEraser.cursorHideTimer) {
      clearTimeout(state.splatEraser.cursorHideTimer);
      state.splatEraser.cursorHideTimer = null;
    }
  }
  syncSplatEraserBrushCursor();
}

function configureSplatEraser(mesh) {
  const { RgbaArray, dyno } = state.sparkPainterApi || {};
  const packedSplats = mesh?.packedSplats;
  if (!RgbaArray || !dyno || !packedSplats?.numSplats) {
    state.splatEraser = null;
    updateSplatEraserUI();
    return;
  }

  const eraser = {
    mesh,
    active: false,
    drawing: false,
    baking: false,
    pointerId: null,
    frameId: null,
    controlsWereEnabled: true,
    autoRotateWasEnabled: false,
    touchLayout: false,
    navigationMode: false,
    staged: false,
    hasSelection: false,
    stageBaseRgba: null,
    history: [],
    cursorX: 0,
    cursorY: 0,
    cursorInside: false,
    cursorNavigation: false,
    cursorHideTimer: null,
    touchPointers: new Map(),
    touchGesture: null,
    touchSequenceNavigating: false,
    brushScale: THREE.MathUtils.clamp(
      (parseFloat(dom.settingSplatEraserSize?.value) || 8) / 100,
      0.02,
      0.2
    ),
    paintEnabled: dyno.dynoBool(false),
    eraseEnabled: dyno.dynoBool(false),
    commitEnabled: dyno.dynoBool(false),
    brushRadius: dyno.dynoFloat(0.05),
    brushDepth: dyno.dynoFloat(10),
    brushOrigin: dyno.dynoVec3(new THREE.Vector3()),
    brushDirection: dyno.dynoVec3(new THREE.Vector3(0, 0, -1)),
    selectionColor: dyno.dynoVec3(new THREE.Vector3(1, 32 / 255, 160 / 255)),
  };
  updateSplatEraserBrushDimensions(eraser);

  mesh.splatRgba = new RgbaArray().fromPackedSplats({
    packedSplats,
    base: 0,
    count: packedSplats.numSplats,
    renderer: state.renderer,
  });
  eraser.modifier = createSplatEraserModifier(eraser);
  mesh.worldModifier = null;
  state.splatEraser = eraser;
  mesh.updateGenerator();
  updateSplatEraserUI();
}

function disposeSplatEraser() {
  const eraser = state.splatEraser;
  if (!eraser) return;
  setSplatEraserActive(false, { silent: true });
  if (eraser.frameId !== null) cancelAnimationFrame(eraser.frameId);
  if (eraser.staged) cancelSplatEraserSelection({ silent: true });
  for (const snapshot of eraser.history) snapshot?.dispose?.();
  eraser.history.length = 0;
  eraser.mesh.worldModifier = null;
  state.splatEraser = null;
  updateSplatEraserUI();
}

const splatEraserRaycaster = new THREE.Raycaster();
const splatEraserPointer = new THREE.Vector2();

function updateSplatEraserRay(event) {
  const eraser = state.splatEraser;
  const canvas = state.renderer?.domElement;
  if (!eraser?.active || !canvas || !state.camera) return false;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  splatEraserPointer.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  state.camera.updateMatrixWorld(true);
  splatEraserRaycaster.setFromCamera(splatEraserPointer, state.camera);
  eraser.brushOrigin.value.copy(splatEraserRaycaster.ray.origin);
  eraser.brushDirection.value.copy(splatEraserRaycaster.ray.direction).normalize();
  updateSplatEraserBrushDimensions(eraser);
  return true;
}

function bakeSplatEraserResult({ preservePrevious = false } = {}) {
  const eraser = state.splatEraser;
  const mesh = eraser?.mesh;
  const { RgbaArray, dyno } = state.sparkPainterApi || {};
  if (!eraser?.active || eraser.baking || !mesh || !RgbaArray || !dyno) return false;

  const cropVisible = state.splatCropEdit?.visible;
  const meshOpacity = mesh.opacity;
  let nextRgba = null;
  eraser.baking = true;
  try {
    // Do not permanently bake the adjustable crop volume or transition opacity
    // into the painter result; only the eraser worldModifier is committed.
    if (state.splatCropEdit) state.splatCropEdit.visible = false;
    mesh.opacity = 1;
    mesh.updateGenerator();
    nextRgba = new RgbaArray();
    nextRgba.render({
      renderer: state.renderer,
      count: mesh.packedSplats.numSplats,
      reader: dyno.dynoBlock(
        { index: 'int' },
        { rgba8: 'vec4' },
        ({ index }) => {
          const { gsplat } = mesh.generator.apply({ index });
          const { rgba } = dyno.splitGsplat(gsplat).outputs;
          return { rgba8: rgba };
        }
      ),
    });
    const previousRgba = mesh.splatRgba;
    mesh.splatRgba = nextRgba;
    nextRgba = null;
    if (state.splatCropEdit) state.splatCropEdit.visible = cropVisible;
    mesh.opacity = meshOpacity;
    mesh.updateGenerator();
    if (!preservePrevious) previousRgba?.dispose?.();
    return true;
  } catch (error) {
    nextRgba?.dispose?.();
    if (state.splatCropEdit) state.splatCropEdit.visible = cropVisible;
    mesh.opacity = meshOpacity;
    mesh.updateGenerator?.();
    console.error('Spark Splat Painter operation failed:', error);
    showToast(
      state.lang === 'zh'
        ? `高斯点擦除失败：${error.message}`
        : `Gaussian erase failed: ${error.message}`,
      'error',
      5000
    );
    return false;
  } finally {
    eraser.baking = false;
  }
}

function beginSplatEraserSelection(eraser) {
  if (!eraser || eraser.staged) return true;
  eraser.stageBaseRgba = eraser.mesh.splatRgba;
  eraser.mesh.worldModifier = null;
  eraser.mesh.updateGenerator();
  if (!bakeSplatEraserResult({ preservePrevious: true })) {
    eraser.stageBaseRgba = null;
    return false;
  }
  eraser.staged = true;
  eraser.hasSelection = false;
  eraser.mesh.worldModifier = eraser.modifier;
  eraser.mesh.updateGenerator();
  updateSplatEraserUI();
  return true;
}

function cancelSplatEraserSelection({ silent = false } = {}) {
  const eraser = state.splatEraser;
  if (!eraser?.staged || !eraser.stageBaseRgba) return false;
  const stagedRgba = eraser.mesh.splatRgba;
  eraser.paintEnabled.value = false;
  eraser.commitEnabled.value = false;
  eraser.mesh.worldModifier = null;
  eraser.mesh.splatRgba = eraser.stageBaseRgba;
  eraser.stageBaseRgba = null;
  eraser.staged = false;
  eraser.hasSelection = false;
  eraser.mesh.updateGenerator();
  if (stagedRgba !== eraser.mesh.splatRgba) stagedRgba?.dispose?.();
  if (eraser.active) {
    eraser.mesh.worldModifier = eraser.modifier;
    eraser.mesh.updateGenerator();
  }
  updateSplatEraserUI();
  if (!silent) {
    showToast(state.lang === 'zh' ? '已撤销当前涂抹选区' : 'Current painted selection cleared', 'info');
  }
  return true;
}

function confirmSplatEraserSelection() {
  const eraser = state.splatEraser;
  if (!eraser?.staged || !eraser.hasSelection || eraser.baking) return;
  eraser.paintEnabled.value = false;
  eraser.commitEnabled.value = true;
  eraser.mesh.worldModifier = eraser.modifier;
  eraser.mesh.updateGenerator();
  const confirmed = bakeSplatEraserResult();
  eraser.commitEnabled.value = false;
  if (!confirmed) return;

  eraser.history.push(eraser.stageBaseRgba);
  if (eraser.history.length > 8) eraser.history.shift()?.dispose?.();
  eraser.stageBaseRgba = null;
  eraser.staged = false;
  eraser.hasSelection = false;
  eraser.mesh.worldModifier = eraser.active ? eraser.modifier : null;
  eraser.mesh.updateGenerator();
  updateSplatEraserUI();
  showToast(state.lang === 'zh' ? '已确认擦除高亮区域' : 'Highlighted splats erased', 'success');
}

function undoSplatEraser() {
  const eraser = state.splatEraser;
  if (!eraser || eraser.baking) return;
  if (eraser.staged) {
    cancelSplatEraserSelection();
    return;
  }
  const previousRgba = eraser.history.pop();
  if (!previousRgba) return;
  const currentRgba = eraser.mesh.splatRgba;
  eraser.mesh.worldModifier = null;
  eraser.mesh.splatRgba = previousRgba;
  eraser.mesh.updateGenerator();
  currentRgba?.dispose?.();
  if (eraser.active) {
    eraser.mesh.worldModifier = eraser.modifier;
    eraser.mesh.updateGenerator();
  }
  updateSplatEraserUI();
  showToast(state.lang === 'zh' ? '已撤销上一次擦除' : 'Last erase undone', 'info');
}

function scheduleSplatEraserBake() {
  const eraser = state.splatEraser;
  if (!eraser?.drawing || eraser.frameId !== null) return;
  eraser.frameId = requestAnimationFrame(() => {
    eraser.frameId = null;
    if (!eraser.drawing) return;
    if (!bakeSplatEraserResult()) setSplatEraserActive(false, { silent: true });
    else {
      eraser.hasSelection = true;
      updateSplatEraserUI();
    }
  });
}

function beginSplatEraserTouchNavigation(eraser) {
  const points = Array.from(eraser.touchPointers.values()).slice(0, 2);
  if (points.length < 2 || !state.camera || !state.controls) return false;
  const [first, second] = points;
  const midpoint = new THREE.Vector2(
    (first.x + second.x) * 0.5,
    (first.y + second.y) * 0.5
  );
  const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
  const offset = state.camera.position.clone().sub(state.controls.target);
  eraser.touchGesture = {
    midpoint,
    distance,
    target: state.controls.target.clone(),
    spherical: new THREE.Spherical().setFromVector3(offset),
  };
  eraser.touchSequenceNavigating = true;
  eraser.cursorNavigation = true;
  hideSplatEraserBrushCursor();
  return true;
}

function updateSplatEraserTouchNavigation(eraser) {
  const gesture = eraser.touchGesture;
  const points = Array.from(eraser.touchPointers.values()).slice(0, 2);
  if (!gesture || points.length < 2 || !state.camera || !state.controls) return false;
  const [first, second] = points;
  const midpointX = (first.x + second.x) * 0.5;
  const midpointY = (first.y + second.y) * 0.5;
  const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
  const spherical = gesture.spherical.clone();
  spherical.theta -= (midpointX - gesture.midpoint.x) * 0.006;
  spherical.phi = THREE.MathUtils.clamp(
    spherical.phi + (midpointY - gesture.midpoint.y) * 0.006,
    0.05,
    Math.PI - 0.05
  );
  spherical.radius = THREE.MathUtils.clamp(
    gesture.spherical.radius * gesture.distance / distance,
    state.controls.minDistance,
    state.controls.maxDistance
  );
  state.controls.target.copy(gesture.target);
  state.camera.position.copy(gesture.target).add(new THREE.Vector3().setFromSpherical(spherical));
  state.camera.lookAt(gesture.target);
  state.controls.update();
  return true;
}

function beginSplatEraserStroke(event) {
  const eraser = state.splatEraser;
  if (!eraser?.active) return;
  if (eraser.touchLayout && event.pointerType === 'touch') {
    eraser.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (eraser.touchPointers.size >= 2) {
      if (eraser.drawing) endSplatEraserStroke();
      beginSplatEraserTouchNavigation(eraser);
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (eraser.touchSequenceNavigating) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
  }
  if (!event.isPrimary || (event.button !== undefined && event.button !== 0)) return;
  if (eraser.navigationMode) return;
  updateSplatEraserBrushCursor(event);
  // Desktop painting keeps OrbitControls enabled. Holding Alt/Option lets the
  // normal left-drag event pass through to OrbitControls for camera rotation.
  if (!eraser.touchLayout && event.altKey) return;
  if (!updateSplatEraserRay(event)) return;
  if (!beginSplatEraserSelection(eraser)) {
    setSplatEraserActive(false, { silent: true });
    return;
  }
  eraser.drawing = true;
  eraser.pointerId = event.pointerId;
  eraser.paintEnabled.value = true;
  eraser.eraseEnabled.value = false;
  state.renderer.domElement.setPointerCapture?.(event.pointerId);
  state.renderer.domElement.style.cursor = eraser.touchLayout ? 'crosshair' : 'none';
  if (!bakeSplatEraserResult()) setSplatEraserActive(false, { silent: true });
  else {
    eraser.hasSelection = true;
    updateSplatEraserUI();
  }
  event.preventDefault();
  event.stopImmediatePropagation();
}

function moveSplatEraserStroke(event) {
  const eraser = state.splatEraser;
  if (eraser?.active && eraser.touchLayout && event.pointerType === 'touch') {
    if (eraser.touchPointers.has(event.pointerId)) {
      eraser.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (eraser.touchSequenceNavigating) {
      updateSplatEraserTouchNavigation(eraser);
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
  }
  if (!eraser?.active || !eraser.drawing || event.pointerId !== eraser.pointerId) return;
  updateSplatEraserBrushCursor(event);
  if (eraser.touchLayout) showMobileSplatEraserBrushPreview(event);
  if (updateSplatEraserRay(event)) scheduleSplatEraserBake();
  event.preventDefault();
  event.stopImmediatePropagation();
}

function endSplatEraserStroke(event) {
  const eraser = state.splatEraser;
  if (eraser?.touchLayout && event?.pointerType === 'touch') {
    eraser.touchPointers.delete(event.pointerId);
    if (eraser.touchSequenceNavigating) {
      if (eraser.touchPointers.size < 2) eraser.touchGesture = null;
      if (eraser.touchPointers.size === 0) {
        eraser.touchSequenceNavigating = false;
        eraser.cursorNavigation = false;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
  }
  if (!eraser?.drawing || (event?.pointerId !== undefined && event.pointerId !== eraser.pointerId)) return;
  if (eraser.frameId !== null) {
    cancelAnimationFrame(eraser.frameId);
    eraser.frameId = null;
  }
  if (event?.clientX !== undefined) updateSplatEraserRay(event);
  const baked = bakeSplatEraserResult();
  eraser.paintEnabled.value = false;
  eraser.eraseEnabled.value = false;
  eraser.drawing = false;
  const canvas = state.renderer?.domElement;
  if (canvas?.hasPointerCapture?.(eraser.pointerId)) canvas.releasePointerCapture(eraser.pointerId);
  eraser.pointerId = null;
  if (canvas) canvas.style.cursor = eraser.active
    ? (eraser.touchLayout ? (eraser.navigationMode ? 'grab' : 'crosshair') : 'none')
    : '';
  if (event?.clientX !== undefined) updateSplatEraserBrushCursor(event);
  if (eraser.touchLayout && event?.clientX !== undefined) showMobileSplatEraserBrushPreview(event);
  event?.preventDefault?.();
  event?.stopImmediatePropagation?.();
  if (!baked) setSplatEraserActive(false, { silent: true });
  else {
    eraser.hasSelection = true;
    updateSplatEraserUI();
  }
}

function setSplatEraserActive(active, { silent = false } = {}) {
  const nextActive = Boolean(active);
  if (nextActive && !state.splatEraser && state.isModelLoaded && state.splatMesh) {
    configureSplatEraser(state.splatMesh);
  }
  const eraser = state.splatEraser;
  if (nextActive && (!eraser || !state.isModelLoaded)) {
    showToast(
      state.lang === 'zh' ? '请先加载支持擦除的 3DGS 模型' : 'Load a 3DGS model before erasing',
      'warning'
    );
    return;
  }
  if (nextActive && (state.previewActive || state.recordingActive || state.compositingActive)) {
    showToast(
      state.lang === 'zh' ? '请先停止预览或视频导出' : 'Stop preview or export before erasing',
      'warning'
    );
    return;
  }
  if (!eraser || eraser.active === nextActive) return;

  if (nextActive) {
    if (state.settings.renderer !== 'spark') setRendererMode('spark', 'button');
    updateSplatEraserBrushDimensions(eraser);
    eraser.touchLayout = isMobileViewport();
    eraser.navigationMode = false;
    eraser.touchPointers.clear();
    eraser.touchGesture = null;
    eraser.touchSequenceNavigating = false;
    eraser.controlsWereEnabled = state.controls?.enabled !== false;
    eraser.autoRotateWasEnabled = Boolean(state.particleSystem?.autoRotate);
    eraser.active = true;
    eraser.mesh.worldModifier = eraser.modifier;
    eraser.mesh.updateGenerator();
    if (state.controls) {
      state.controls.enabled = eraser.touchLayout ? false : eraser.controlsWereEnabled;
    }
    if (state.particleSystem) state.particleSystem.autoRotate = false;
    document.body.classList.add('splat-eraser-active');
    if (state.renderer?.domElement) {
      state.renderer.domElement.style.cursor = eraser.touchLayout ? 'crosshair' : 'none';
    }
    syncSplatEraserBrushCursor();
    if (!silent) {
      showToast(
        state.lang === 'zh'
          ? (eraser.touchLayout
            ? '橡皮擦已开启：单指涂抹，双指调整视角或缩放'
            : '左键涂抹，[ / ] 调整大小；Alt/Option 拖动旋转，滚轮缩放、右键平移')
          : (eraser.touchLayout
            ? 'Eraser enabled: paint with one finger; use two fingers to orbit or zoom'
            : 'Paint with left-drag; [ / ] resizes; Alt/Option-drag orbits, wheel zooms, right-drag pans'),
        'info',
        5000
      );
    }
  } else {
    if (eraser.drawing) endSplatEraserStroke();
    if (eraser.staged) cancelSplatEraserSelection({ silent: true });
    eraser.paintEnabled.value = false;
    eraser.eraseEnabled.value = false;
    eraser.commitEnabled.value = false;
    eraser.touchPointers.clear();
    eraser.touchGesture = null;
    eraser.touchSequenceNavigating = false;
    eraser.active = false;
    eraser.mesh.worldModifier = null;
    eraser.mesh.updateGenerator();
    if (state.controls && !state.previewActive && !state.recordingActive) {
      state.controls.enabled = eraser.controlsWereEnabled;
    }
    if (state.particleSystem) state.particleSystem.autoRotate = eraser.autoRotateWasEnabled;
    document.body.classList.remove('splat-eraser-active');
    if (state.renderer?.domElement) state.renderer.domElement.style.cursor = '';
    hideSplatEraserBrushCursor();
  }
  updateSplatEraserUI();
  syncSplatCropHelperVisibility();
}
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
    btnToggleRotation: document.getElementById('btn-toggle-rotation'),
    btnMobileToggleRotation: document.getElementById('btn-mobile-toggle-rotation'),
    settingsPanel: document.getElementById('settings-panel'),
    btnDesktopParticleSettings: document.getElementById('btn-desktop-particle-settings'),
    btnDesktopSplatSettings: document.getElementById('btn-desktop-splat-settings'),
    btnMobileParticleSettings: document.getElementById('btn-mobile-particle-settings'),
    btnMobileSplatSettings: document.getElementById('btn-mobile-splat-settings'),
    btnMobileSettingsReset: document.getElementById('btn-mobile-settings-reset'),
    btnMobileSettingsConfirm: document.getElementById('btn-mobile-settings-confirm'),
    mobileSettingsGroupLabel: document.getElementById('mobile-settings-group-label'),
    mobileCameraOptions: document.getElementById('mobile-camera-options'),
    desktopFlightAnchor: document.getElementById('desktop-flight-anchor'),
    flightPresetItem: document.getElementById('flight-preset-item'),
    settingMaxParticles: document.getElementById('setting-max-particles'),
    settingCropFactor: document.getElementById('setting-crop-factor'),
    settingCropFactorVal: document.getElementById('setting-crop-factor-val'),
    btnMobileSplatCropPanel: document.getElementById('btn-mobile-splat-crop-panel'),
    btnMobileSplatEraserPanel: document.getElementById('btn-mobile-splat-eraser-panel'),
    splatCropControls: document.getElementById('splat-crop-controls'),
    particleCropControls: document.getElementById('particle-crop-controls'),
    btnParticleCropToggle: document.getElementById('btn-particle-crop-toggle'),
    btnSplatCropToggle: document.getElementById('btn-splat-crop-toggle'),
    btnSplatEraser: document.getElementById('btn-splat-eraser'),
    btnSplatEraserPaint: document.getElementById('btn-splat-eraser-paint'),
    btnSplatEraserConfirm: document.getElementById('btn-splat-eraser-confirm'),
    btnSplatEraserUndo: document.getElementById('btn-splat-eraser-undo'),
    settingSplatEraserSize: document.getElementById('setting-splat-eraser-size'),
    settingSplatEraserSizeVal: document.getElementById('setting-splat-eraser-size-val'),
    splatEraserStatus: document.getElementById('splat-eraser-status'),
    splatEraserToolTitle: document.querySelector('.splat-eraser-tool-title-text'),
    splatEraserBrushCursor: document.getElementById('splat-eraser-brush-cursor'),
    btnSplatCropShapeEllipsoid: document.getElementById('btn-splat-crop-shape-ellipsoid'),
    btnSplatCropShapeBox: document.getElementById('btn-splat-crop-shape-box'),
    btnMobileSplatCropNone: document.getElementById('btn-mobile-splat-crop-none'),
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
    cameraScatterEffect: document.getElementById('camera-scatter-effect'),
    desktopCameraScatterItem: document.getElementById('desktop-camera-scatter-item'),

    loadingOverlay: document.getElementById('loading-overlay'),
    loadingText: document.getElementById('loading-text'),
    loadingBar: document.getElementById('loading-bar'),
    btnCancelComposition: document.getElementById('btn-cancel-composition'),
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
    keyframeLimit: document.getElementById('keyframe-limit'),
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
  syncSplatCropHelperVisibility();
}

function updateMobileSettingsUI() {
  if (!dom.settingsPanel) return;
  if (!isMobileViewport()) {
    dom.settingsPanel.classList.remove(
      'mobile-settings-root',
      'mobile-settings-detail',
      'mobile-settings-particles',
      'mobile-settings-spark',
      'mobile-splat-crop-view',
      'mobile-splat-eraser-view'
    );
    return;
  }

  if (
    !dom.settingsPanel.classList.contains('mobile-settings-root')
    && !dom.settingsPanel.classList.contains('mobile-settings-detail')
  ) {
    dom.settingsPanel.classList.add('mobile-settings-root');
  }

  const isSpark = state.settings.renderer === 'spark';
  dom.settingsPanel.classList.toggle('mobile-settings-particles', !isSpark);
  dom.settingsPanel.classList.toggle('mobile-settings-spark', isSpark);
  if (dom.mobileSettingsGroupLabel) {
    dom.mobileSettingsGroupLabel.textContent = isSpark
      ? (state.lang === 'zh' ? '3DGS 设置' : '3DGS Settings')
      : (state.lang === 'zh' ? '粒子设置' : 'Particle Settings');
  }
  if (
    !dom.settingsPanel.classList.contains('mobile-splat-crop-view')
    && !dom.settingsPanel.classList.contains('mobile-splat-eraser-view')
  ) {
    dom.settingsPanel.classList.add('mobile-splat-crop-view');
  }

  for (const [button, selected] of [
    [dom.btnMobileParticleSettings, !isSpark],
    [dom.btnMobileSplatSettings, isSpark],
  ]) {
    if (!button) continue;
    button.classList.remove('active');
    button.setAttribute('aria-selected', String(selected));
  }

  const cropSelected = dom.settingsPanel.classList.contains('mobile-splat-crop-view');
  for (const [button, selected] of [
    [dom.btnMobileSplatCropPanel, cropSelected],
    [dom.btnMobileSplatEraserPanel, !cropSelected],
  ]) {
    if (!button) continue;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  }
  updateSplatCropShapeUI();
}

function setMobileSettingsLevel(level) {
  if (!dom.settingsPanel || !isMobileViewport()) return;
  const showDetail = level === 'detail';
  dom.settingsPanel.classList.toggle('mobile-settings-root', !showDetail);
  dom.settingsPanel.classList.toggle('mobile-settings-detail', showDetail);
  if (!showDetail && state.splatEraser?.active) {
    setSplatEraserActive(false, { silent: true });
  }
  updateMobileSettingsUI();
  syncSplatCropHelperVisibility();
}

function setMobileSettingsMode(mode) {
  setRendererMode(mode, 'settings');
  setMobileSettingsLevel('detail');
  updateMobileSettingsUI();
  syncSplatCropHelperVisibility();
}

function setMobileSplatTool(tool) {
  if (!dom.settingsPanel || !isMobileViewport()) return;
  const showEraser = tool === 'eraser';
  dom.settingsPanel.classList.toggle('mobile-splat-crop-view', !showEraser);
  dom.settingsPanel.classList.toggle('mobile-splat-eraser-view', showEraser);
  if (!showEraser && state.splatEraser?.active) {
    setSplatEraserActive(false, { silent: true });
  }
  updateMobileSettingsUI();
  syncSplatCropHelperVisibility();
}

function resetMobileSettingsParameter() {
  if (!isMobileViewport()) return;
  if (state.settings.renderer === 'spark') {
    if (dom.settingsPanel?.classList.contains('mobile-splat-eraser-view')) {
      if (state.splatEraser?.staged) cancelSplatEraserSelection({ silent: true });
      setSplatEraserBrushPercent(8);
    } else {
      state.settings.splatCropEnabled = false;
      state.settings.splatCropRadiiScale = { x: 1, y: 1, z: 1 };
      state.settings.splatCropOffset = { x: 0, y: 0, z: 0 };
      updateCropToggleUI(dom.btnSplatCropToggle, false, 'splat');
      applySplatCropShape('ellipsoid');
      updateSplatCropFromSettings();
    }
  } else {
    const activeTarget = document.querySelector('.mobile-particle-setting-tag.active')?.dataset.settingTarget;
    const sliderDefaults = {
      'setting-size-item': [dom.settingPointSize, 0.20],
      'setting-brightness-item': [dom.settingParticleBrightness, 0.70],
      'setting-density-item': [dom.settingPointDensity, 1.00],
    };
    if (activeTarget === 'setting-crop-item') {
      state.settings.cropOutliers = true;
      updateCropToggleUI(dom.btnParticleCropToggle, true, 'particle');
      state.particleSystem?.setCropEnabled(true);
      if (dom.settingCropFactor) {
        dom.settingCropFactor.value = '2.5';
        dom.settingCropFactor.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else {
      const [slider, defaultValue] = sliderDefaults[activeTarget] || [];
      if (slider) {
        slider.value = String(defaultValue);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }
  showToast(state.lang === 'zh' ? '当前参数已重置' : 'Current parameter reset', 'info', 1800);
}

function confirmMobileSettings() {
  if (!isMobileViewport()) return;
  setMobileSettingsLevel('root');
  showToast(state.lang === 'zh' ? '参数已保存' : 'Settings saved', 'success', 1600);
}

function syncResponsiveControlLayout() {
  if (!dom.mobileCameraOptions || !dom.flightPresetItem || !dom.desktopCameraScatterItem) return;

  const mobile = isMobileViewport();
  dom.settingsPanel?.classList.toggle('desktop-settings-layout', !mobile);
  if (mobile) {
    dom.mobileCameraOptions.append(dom.flightPresetItem, dom.desktopCameraScatterItem);
  } else {
    dom.desktopFlightAnchor.after(dom.flightPresetItem);
    dom.flightPresetItem.after(dom.desktopCameraScatterItem);
  }
  updateDesktopSettingsUI();
  updateMobileSettingsUI();
}

function syncModelRendererVisibility() {
  if (!state.isModelLoaded) return;
  const showParticles = state.splatInterpolation < (1.0 - RENDERER_VISIBILITY_EPSILON);
  // Keep transparent 3DGS rendering alive briefly before an exported
  // particle -> reality switch. Spark can then settle its camera sorting and
  // SplatEdit crop before the first visible 3DGS frame is encoded.
  const showSpark = state.sparkPrewarmActive
    || state.splatInterpolation > RENDERER_VISIBILITY_EPSILON;

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
    'btn-upload-title': '上传本地 PLY 或 Splat 文件',
    'btn-upload-text': '上传模型',
    'btn-spark-title': '切换 3D 实景模式',
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
    'btn-stop-rotation': '停止旋转',
    'btn-resume-rotation': '继续旋转',
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
    'preset-inceptionPush': '16. 盗梦空间缓慢推进旋转',
    'btn-add-keyframe': '添加关键帧',
    'btn-clear-keyframes': '清空',
    'btn-preview-path': '预览',
    'btn-export-video': '导出视频',
    'btn-stop-preview': '停止预览',
    'btn-stop-composition': '停止合成',
    'stopping-composition': '正在停止合成…',
    'compositing-video': '正在逐帧合成 1080p 视频',
    'finalizing-video': '正在封装 MP4 视频',
    'fallback-recording': '逐帧合成不可用，正在切换到实时录制',
    'composition-failed-no-fallback': '逐帧视频合成失败，未切换到实时录制',
    // Rendering Settings
    'settings-title': '渲染设置',
    'desktop-particle-settings': '粒子设置',
    'desktop-splat-settings': '3DGS 设置',
    'label-max-particles': '最大粒子数 (点云模式)',
    'opt-particles-50k': '50,000 (极速)',
    'opt-particles-150k': '150,000 (推荐)',
    'opt-particles-300k': '300,000 (高精)',
    'opt-particles-500k': '500,000 (极精)',
    'label-crop-factor': '粒子裁剪背景',
    'label-splat-crop-factor': '3DGS 裁剪背景',
    'label-splat-crop-shape': '裁剪形状',
    'splat-crop-shape-ellipsoid': '椭球',
    'splat-crop-shape-box': '方形',
    'splat-crop-shape-none': '无',
    'splat-crop-direct-hint': '拖动裁剪框上的 X / Y / Z 箭头调整各面',
    'btn-splat-eraser': '高斯点擦除',
    'btn-splat-eraser-exit': '退出高斯点擦除',
    'splat-eraser-tool-title': '高斯点橡皮擦',
    'splat-eraser-size': '橡皮擦大小',
    'btn-mobile-splat-crop': '裁剪背景',
    'btn-mobile-splat-eraser': '橡皮擦',
    'btn-mobile-settings-reset': '重置当前参数',
    'btn-mobile-settings-confirm': '保存参数',
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
    'guide-palm': '张开手掌：粒子消散',
    'guide-fist': '握拳：粒子聚集',
    'guide-victory': '剪刀手：切换模式',
    'guide-zoom': '双拳缩放：缩放模型',
    'guide-pointing': '食指：控制模型视角',
    // Remy Intro
    'remy-intro-title': '关于 Remy',
    'remy-visit-link': '→前往 Remy 官网',
    'remy-intro-content': '照片视频很美好，但 3D 影像更显珍贵。Remy 是一款 3D 空间记录 App，让美好记忆场景可以保存并沉浸式体验。本网页使用 Vibe Coding 制作，你可以导入 Remy 已生成的 3D 影像，体验自定义运镜、发光粒子特效、手势控制等玩法，让 3D 影像变成更好玩的数字载体，祝你玩的开心！',
    // Welcome Hint & Loading
    'welcome-title': 'Remy 自定义特效运镜工具',
    'welcome-desc': '在下方输入框中粘贴 <a href="https://www.remy3d.cn/" target="_blank" rel="noopener" class="desc-link">Remy3D</a> 或 <a href="https://www.kiriengine.app/" target="_blank" rel="noopener" class="desc-link">Kiri Engine</a> 分享链接，即可开始您的 3D 粒子和 3DGS 实景体验。',
    'landing-url-placeholder': '粘贴 Remy3D 分享链接，无链接直接点击加载体验',
    'loading-init': '加载中...',
    'loading-downloading': '正在获取 3DGS 数据，请稍候...',
    'loading-parsing': '正在读取 PLY 点云数据，请稍候...',
    'loading-processing': '正在构建 GPU 渲染管线...',
    'loading-spark': '正在加载并初始化渲染引擎...',
    // Alerts/Toasts
    'enter-valid-url': '请输入 Remy3D 或 Kiri Engine 分享链接',
    'enter-valid-url-2': '请输入有效的 Remy3D 或 Kiri Engine 分享链接',
    'failed-parse-ply': '解析 PLY 文件失败: ',
    'failed-load-spark': '加载渲染引擎失败: ',
    'loaded-success-prefix': '',
    'loaded-success-suffix': ' 元素已加载',
    'spark-load-failed': '渲染引擎载入失败: ',
    'gesture-tracking-active': '手势控制已激活！张开/合拢手掌可控制消散，双手拳头微调模型缩放，比出剪刀手并保持0.7秒可切换模式',
    'flight-preview-finished': '镜头运镜预览已结束',
    'gesture-switched-spark': '手势触发：已切换至 3D实景',
    'gesture-switched-cloud': '手势触发：已切换至粒子模式',
    'spark-mode-enabled': '已切换至 3D实景',
    'point-cloud-enabled': '已切换至粒子模式',
    'load-model-first': '请先加载一个 3D 模型',
    'camera-path-active': '镜头运镜模式已开启：调整视角并点击“添加关键帧”！',
    'max-keyframes-allowed': '手机端最多只能录制 10 个关键帧',
    'keyframe-recorded-prefix': '关键帧 ',
    'keyframe-recorded-suffix': ' 已成功录制！',
    'keyframes-cleared': '所有关键帧已清空',
    'keyframe-removed': '已删除该关键帧',
    'flight-preview-stopped': '运镜预览已停止',
    'looping-preset': '正在循环播放内置运镜预设: ',
    'previewing-camera-flight': '正在预览镜头自定义轨迹飞行...',
    'video-exported-success': 'MP4 运镜视频成功导出并已开始下载！',
    'recording-camera-flight-toast': '正在后台进行离屏 1080p 超清运镜录制中，请稍候...',
    'drop-ply-only': '请拖放有效的 .ply 或 .splat 格式文件',
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
    'loading-spark-engine': '正在载入渲染引擎...',
    'parsing-model-data': '正在解析模型点云数据...',
    'creating-particles': '正在生成 GPU 粒子云几何体...',
    'loading-spark-3dgs': '正在加载 3D 实景...',
    'done': '完成！',
    'spark-load-prefix': '渲染引擎加载中: ',
    'spark-load-suffix': '',
    'reapplying-settings': '正在重新应用设置...',
    'configuring-render': '正在配置 1080p 超清离屏渲染管线...'
  },
  en: {
    // Toolbar
    'url-placeholder': 'Paste Remy3D or Kiri Engine share URL...',
    'btn-load-title': 'Load model from URL',
    'btn-load-text': 'Load',
    'btn-upload-title': 'Upload local PLY or Splat file',
    'btn-upload-text': 'Upload Model',
    'btn-spark-title': 'Toggle 3D Reality mode',
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
    'btn-stop-rotation': 'Stop Rotation',
    'btn-resume-rotation': 'Resume Rotation',
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
    'preset-inceptionPush': '16. Inception Push & Roll',
    'btn-add-keyframe': 'Add Keyframe',
    'btn-clear-keyframes': 'Clear',
    'btn-preview-path': 'Preview',
    'btn-export-video': 'Export Video',
    'btn-stop-preview': 'Stop Preview',
    'btn-stop-composition': 'Stop Compositing',
    'stopping-composition': 'Stopping composition…',
    'compositing-video': 'Compositing 1080p video frame by frame',
    'finalizing-video': 'Finalizing MP4 video',
    'fallback-recording': 'Frame composition unavailable; switching to live recording',
    'composition-failed-no-fallback': 'Frame composition failed; live recording was not started',
    // Rendering Settings
    'settings-title': 'Rendering Settings',
    'desktop-particle-settings': 'Particle Settings',
    'desktop-splat-settings': '3DGS Settings',
    'label-max-particles': 'Max Particles (Particle Cloud)',
    'opt-particles-50k': '50,000 (Fastest)',
    'opt-particles-150k': '150,000 (Recommended)',
    'opt-particles-300k': '300,000 (High Detail)',
    'opt-particles-500k': '500,000 (Maximum)',
    'label-crop-factor': 'Particle Background Crop',
    'label-splat-crop-factor': '3DGS Background Crop',
    'label-splat-crop-shape': 'Crop Shape',
    'splat-crop-shape-ellipsoid': 'Ellipsoid',
    'splat-crop-shape-box': 'Box',
    'splat-crop-shape-none': 'None',
    'splat-crop-direct-hint': 'Drag the X / Y / Z arrows on the crop volume to adjust each face',
    'btn-splat-eraser': 'Erase Gaussian splats',
    'btn-splat-eraser-exit': 'Exit Gaussian eraser',
    'splat-eraser-tool-title': 'Gaussian Splat Eraser',
    'splat-eraser-size': 'Eraser Size',
    'btn-mobile-splat-crop': 'Crop Background',
    'btn-mobile-splat-eraser': 'Eraser',
    'btn-mobile-settings-reset': 'Reset current parameter',
    'btn-mobile-settings-confirm': 'Save settings',
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
    'guide-palm': 'Open Palm: Dissipate',
    'guide-fist': 'Closed Fist: Assemble',
    'guide-victory': 'Victory: Toggle Mode',
    'guide-zoom': 'Two Fists: Scale Model',
    'guide-pointing': 'Index Finger: Rotate View',
    // Remy Intro
    'remy-intro-title': 'About Remy',
    'remy-visit-link': '→ Visit Remy',
    'remy-intro-content': 'Photos and videos are beautiful, but 3D imagery is even more precious. Remy is a 3D spatial capture App that preserves cherished memories for immersive replay. Built using Vibe Coding, this web app lets you import your Remy 3D captures to experiment with custom camera paths, glowing particle effects, and hand gestures. Let\'s make 3D captures a more playful digital medium. Have fun!',
    // Welcome Hint & Loading
    'welcome-title': 'Remy Custom Effects & Camera Tool',
    'welcome-desc': 'Paste a <a href="https://www.remy3d.cn/" target="_blank" rel="noopener" class="desc-link">Remy3D</a> or <a href="https://www.kiriengine.app/" target="_blank" rel="noopener" class="desc-link">Kiri Engine</a> share URL below to explore Particle Mode and 3D Reality.',
    'landing-url-placeholder': 'Paste a Remy3D share link, or load without one to try the demo',
    'loading-init': 'Loading...',
    'loading-downloading': 'Downloading 3DGS data, please wait...',
    'loading-parsing': 'Parsing PLY point cloud, please wait...',
    'loading-processing': 'Building GPU pipeline...',
    'loading-spark': 'Loading and initializing the rendering engine...',
    // Alerts/Toasts
    'enter-valid-url': 'Please enter a Remy3D or Kiri Engine share URL',
    'enter-valid-url-2': 'Please enter a valid Remy3D or Kiri Engine share URL',
    'failed-parse-ply': 'Failed to parse PLY file: ',
    'failed-load-spark': 'Failed to load rendering engine: ',
    'loaded-success-prefix': '',
    'loaded-success-suffix': ' elements loaded',
    'spark-load-failed': 'Rendering engine load failed: ',
    'gesture-tracking-active': 'Hand tracking active! Open/close hand to morph, two fists to scale model, Victory gesture (hold 0.7s) to toggle mode',
    'flight-preview-finished': 'Flight preview finished',
    'gesture-switched-spark': 'Gesture: Switched to 3D Reality',
    'gesture-switched-cloud': 'Gesture: Switched to Particle Mode',
    'spark-mode-enabled': '3D Reality enabled',
    'point-cloud-enabled': 'Particle Mode enabled',
    'load-model-first': 'Please load a model first',
    'camera-path-active': 'Camera Path Mode active: Adjust view and record keyframes!',
    'max-keyframes-allowed': 'Mobile devices support up to 10 keyframes',
    'keyframe-recorded-prefix': 'Keyframe ',
    'keyframe-recorded-suffix': ' recorded!',
    'keyframes-cleared': 'All keyframes cleared',
    'keyframe-removed': 'Keyframe removed',
    'flight-preview-stopped': 'Flight preview stopped',
    'looping-preset': 'Looping preset: ',
    'previewing-camera-flight': 'Previewing camera flight path...',
    'video-exported-success': 'Video exported successfully!',
    'recording-camera-flight-toast': 'Recording 1080p MP4 camera flight...',
    'drop-ply-only': 'Please drop a valid .ply or .splat file',
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
    'loading-spark-engine': 'Loading rendering engine...',
    'parsing-model-data': 'Parsing model data...',
    'creating-particles': 'Creating Particle Cloud...',
    'loading-spark-3dgs': 'Loading 3D Reality...',
    'done': 'Done!',
    'spark-load-prefix': 'Rendering engine loading: ',
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

function setInlineIcon(iconElement, symbolId, { spinning = false } = {}) {
  if (!iconElement) return;
  const useElement = iconElement.querySelector('use');
  if (useElement) useElement.setAttribute('href', `#${symbolId}`);
  iconElement.classList.toggle('is-spinning', spinning);
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
      dom.selectPresetFlight.options[16].textContent = dict['preset-inceptionPush'];
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
    updatePreviewStopButton();
    if (dom.btnCancelComposition && !state.compositionCancelRequested) {
      dom.btnCancelComposition.textContent = dict['btn-stop-composition'];
    }
    if (dom.btnPreviewExport) dom.btnPreviewExport.textContent = dict['btn-export-video'];
    if (dom.btnRecordingStop) dom.btnRecordingStop.textContent = lang === 'zh' ? '停止导出' : 'Stop Export';
    if (dom.recordingIndicator) dom.recordingIndicator.textContent = lang === 'zh' ? '录制中' : 'Recording';
    if (dom.btnHome) dom.btnHome.textContent = lang === 'zh' ? '首页' : 'Home';
    if (dom.btnExportVideo) dom.btnExportVideo.textContent = dict['btn-export-video'];
  }
  updateRotationControls();

  // Settings Panel
  if (dom.settingsPanel) {
    const h3 = dom.settingsPanel.querySelector('h3');
    if (h3) h3.textContent = dict['settings-title'];
    if (dom.btnDesktopParticleSettings) {
      dom.btnDesktopParticleSettings.textContent = dict['desktop-particle-settings'];
    }
    if (dom.btnDesktopSplatSettings) {
      dom.btnDesktopSplatSettings.textContent = dict['desktop-splat-settings'];
    }
    if (dom.btnMobileParticleSettings) {
      dom.btnMobileParticleSettings.textContent = dict['desktop-particle-settings'];
    }
    if (dom.btnMobileSplatSettings) {
      dom.btnMobileSplatSettings.textContent = dict['desktop-splat-settings'];
    }
    if (dom.splatEraserToolTitle) {
      dom.splatEraserToolTitle.textContent = dict['splat-eraser-tool-title'];
    }
    const eraserSizeLabel = dom.settingsPanel.querySelector('label[for="setting-splat-eraser-size"]');
    if (eraserSizeLabel) eraserSizeLabel.textContent = dict['splat-eraser-size'];
    
    const labelParticles = dom.settingsPanel.querySelector('label[for="setting-max-particles"]');
    if (labelParticles) labelParticles.textContent = dict['label-max-particles'];
    const labelCrop = dom.settingsPanel.querySelector('label[for="setting-crop-factor"]');
    if (labelCrop) labelCrop.textContent = dict['label-crop-factor'];
    const labelSplatCrop = dom.settingsPanel.querySelector('.splat-crop-title');
    if (labelSplatCrop) labelSplatCrop.textContent = dict['label-splat-crop-factor'];
    const splatCropShapeLabel = dom.settingsPanel.querySelector('.splat-crop-shape-label');
    if (splatCropShapeLabel) splatCropShapeLabel.textContent = dict['label-splat-crop-shape'];
    if (dom.btnSplatCropShapeEllipsoid) {
      dom.btnSplatCropShapeEllipsoid.textContent = dict['splat-crop-shape-ellipsoid'];
    }
    if (dom.btnSplatCropShapeBox) {
      dom.btnSplatCropShapeBox.textContent = dict['splat-crop-shape-box'];
    }
    if (dom.btnMobileSplatCropNone) {
      dom.btnMobileSplatCropNone.textContent = dict['splat-crop-shape-none'];
    }
    const mobileSplatCropShapeTitle = dom.settingsPanel.querySelector('.mobile-splat-crop-shape-title');
    if (mobileSplatCropShapeTitle) {
      mobileSplatCropShapeTitle.textContent = dict['label-splat-crop-shape'];
    }
    updateSplatEraserUI();
    if (dom.btnMobileSplatCropPanel) {
      dom.btnMobileSplatCropPanel.textContent = dict['btn-mobile-splat-crop'];
    }
    if (dom.btnMobileSplatEraserPanel) {
      dom.btnMobileSplatEraserPanel.textContent = dict['btn-mobile-splat-eraser'];
    }
    if (dom.btnMobileSettingsReset) {
      dom.btnMobileSettingsReset.title = dict['btn-mobile-settings-reset'];
      dom.btnMobileSettingsReset.setAttribute('aria-label', dict['btn-mobile-settings-reset']);
    }
    if (dom.btnMobileSettingsConfirm) {
      dom.btnMobileSettingsConfirm.title = dict['btn-mobile-settings-confirm'];
      dom.btnMobileSettingsConfirm.setAttribute('aria-label', dict['btn-mobile-settings-confirm']);
    }
    if (dom.mobileSettingsGroupLabel) {
      dom.mobileSettingsGroupLabel.textContent = state.settings.renderer === 'spark'
        ? dict['desktop-splat-settings']
        : dict['desktop-particle-settings'];
    }
    const splatCropDirectHint = dom.settingsPanel.querySelector('.splat-crop-direct-hint-text');
    if (splatCropDirectHint) splatCropDirectHint.textContent = dict['splat-crop-direct-hint'];
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
    const cameraScatterLabel = dom.desktopCameraScatterItem?.querySelector('label[for="camera-scatter-effect"]');
    if (cameraScatterLabel) cameraScatterLabel.textContent = dict['label-scatter-effect'];

    const mobileTags = document.querySelectorAll('.mobile-particle-setting-tag');
    const tagLabels = lang === 'zh'
      ? ['裁剪背景', '粒子大小', '粒子亮度', '粒子密度']
      : ['Crop Background', 'Particle Size', 'Particle Light', 'Particle Density'];
    mobileTags.forEach((tag, index) => {
      tag.textContent = tagLabels[index];
    });
    updateCropToggleUI(dom.btnParticleCropToggle, state.settings.cropOutliers, 'particle');
    updateCropToggleUI(dom.btnSplatCropToggle, state.settings.splatCropEnabled, 'splat');
    updateSplatCropShapeUI();
    
    if (dom.settingMaxParticles) {
      dom.settingMaxParticles.options[0].textContent = dict['opt-particles-50k'];
      dom.settingMaxParticles.options[1].textContent = dict['opt-particles-150k'];
      dom.settingMaxParticles.options[2].textContent = dict['opt-particles-300k'];
      dom.settingMaxParticles.options[3].textContent = dict['opt-particles-500k'];
    }

    for (const effectSelect of [dom.cameraScatterEffect]) {
      if (effectSelect) {
        for (const opt of effectSelect.options) {
          const val = opt.value;
          if (dict[`effect-${val}`]) {
            opt.textContent = dict[`effect-${val}`];
          }
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
  if (guidePalm) guidePalm.querySelector('.gesture-guide-label').textContent = dict['guide-palm'];
  const guideFist = document.getElementById('guide-fist');
  if (guideFist) guideFist.querySelector('.gesture-guide-label').textContent = dict['guide-fist'];
  const guideVictory = document.getElementById('guide-victory');
  if (guideVictory) guideVictory.querySelector('.gesture-guide-label').textContent = dict['guide-victory'];
  const guideZoom = document.getElementById('guide-zoom');
  if (guideZoom) guideZoom.querySelector('.gesture-guide-label').textContent = dict['guide-zoom'];
  const guidePointing = document.getElementById('guide-pointing');
  if (guidePointing) guidePointing.querySelector('.gesture-guide-label').textContent = dict['guide-pointing'];
  
  // Translate Remy Intro panel
  const remyTitle = document.getElementById('remy-intro-title');
  if (remyTitle) remyTitle.querySelector('.remy-intro-title-text').textContent = dict['remy-intro-title'];
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
  dom.loadingBar.dataset.progressPercent = '0';
}
function updateLoadingProgress(progress, text) {
  const progressPercent = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  if (dom.loadingBar.dataset.progressPercent !== String(progressPercent)) {
    dom.loadingBar.style.width = `${progressPercent}%`;
    dom.loadingBar.dataset.progressPercent = String(progressPercent);
  }
  if (text) {
    let translatedText = text;
    const dict = translations[state.lang];
    if (dict) {
      if (text === 'Parsing share page...') {
        translatedText = dict['parsing-share'];
      } else if (text === 'Loading rendering engine...') {
        translatedText = dict['loading-spark-engine'];
      } else if (text === 'Parsing model data...') {
        translatedText = dict['parsing-model-data'];
      } else if (text === 'Creating Particle Cloud...') {
        translatedText = dict['creating-particles'];
      } else if (text === 'Loading 3D Reality...') {
        translatedText = dict['loading-spark-3dgs'];
      } else if (text === 'Done!') {
        translatedText = dict['done'];
      } else if (text.startsWith('Downloading: ')) {
        const fileAndPercent = text.replace('Downloading: ', '');
        translatedText = dict['downloading-prefix'] + fileAndPercent + dict['downloading-suffix'];
      } else if (text.startsWith('Parsing: ')) {
        translatedText = dict['parsing-model-data'] + ' ' + text.replace('Parsing: ', '');
      } else if (text.startsWith('Rendering engine load: ')) {
        translatedText = dict['spark-load-prefix'] + text.replace('Rendering engine load: ', '') + dict['spark-load-suffix'];
      }
    }
    if (dom.loadingText.textContent !== translatedText) {
      dom.loadingText.textContent = translatedText;
    }
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
      } else if (message.startsWith('Failed to load rendering engine: ')) {
        translatedMessage = dict['failed-load-spark'] + message.replace('Failed to load rendering engine: ', '');
      } else if (message.startsWith('Rendering engine load failed: ')) {
        translatedMessage = dict['spark-load-failed'] + message.replace('Rendering engine load failed: ', '');
      } else if (message.startsWith('Keyframe ') && message.endsWith(' recorded!')) {
        const num = message.replace('Keyframe ', '').replace(' recorded!', '');
        translatedMessage = dict['keyframe-recorded-prefix'] + num + dict['keyframe-recorded-suffix'];
      } else if (message.startsWith('Looping preset: ')) {
        translatedMessage = dict['looping-preset'] + message.replace('Looping preset: ', '');
      } else if (message.includes('elements loaded') && message.includes('—')) {
        const parts = message.split('—');
        const num = parts[1].replace('elements loaded', '').trim();
        translatedMessage = parts[0] + '— ' + num + dict['loaded-success-suffix'];
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
    let lastDownloadError = null;
    const downloadResolvedModel = async (resolvedModel) => {
      const urlsToTry = [
        resolvedModel.splatUrl,
        resolvedModel.plyUrl,
        resolvedModel.pcdUrl
      ].filter(Boolean);

      for (const tryUrl of urlsToTry) {
        try {
          return await downloadPLY(tryUrl, (p) => {
            updateLoadingProgress(0.2 + p * 0.5, `Downloading: ${Math.round(p * 100)}%`);
          });
        } catch (error) {
          lastDownloadError = error;
          console.warn(`Failed to download ${tryUrl.substring(0, 60)}:`, error.message);
        }
      }
      return null;
    };

    // Step 1: Extract PLY/Splat URL from the share page
    updateLoadingProgress(0.1, 'Parsing share page...');
    let result = await extractPLYFromUrl(url);
    state.initialCameraPosition = result.initialCameraPosition || null;
    if (!result.plyUrl && !result.pcdUrl && !result.splatUrl) {
      throw new Error('No 3D model file URL found');
    }
    // Step 2: Download the file (try 3DGS.splat -> 3DGS.ply -> pcd.ply)
    updateLoadingProgress(0.2, `Downloading: ${result.name}...`);
    let buffer = await downloadResolvedModel(result);

    // A Remy share page may be cached with an expired signed model URL.
    // Re-resolve once before reporting a download failure.
    if (!buffer) {
      updateLoadingProgress(0.1, 'Parsing share page...');
      result = await extractPLYFromUrl(url, { forceRefresh: true });
      state.initialCameraPosition = result.initialCameraPosition || null;
      updateLoadingProgress(0.2, `Downloading: ${result.name}...`);
      buffer = await downloadResolvedModel(result);
    }

    if (!buffer) {
      const reason = lastDownloadError?.message ? ` (${lastDownloadError.message})` : '';
      throw new Error(`Could not load model data from this share link.${reason}`);
    }
    // Step 3: Parse and create particles
    await processBuffer(buffer, result.name, true);
  } catch (error) {
    hideLoading();
    console.error('Load from URL failed:', error);
    showToast(
      state.lang === 'zh'
        ? `模型加载失败：${error.message} 请检查分享链接后重试。`
        : `Loading failed: ${error.message} Please verify the share link and try again.`,
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
    await processBuffer(buffer, file.name.replace(/\.(?:ply|splat)$/i, ''), true);
  } catch (error) {
    hideLoading();
    console.error('Load from file failed:', error);
    showToast(
      state.lang === 'zh'
        ? `模型文件解析失败：${error.message}`
        : `Failed to parse model file: ${error.message}`,
      'error'
    );
  }
}
/**
 * Clean up existing 3D objects to prevent memory leaks.
 */
function disposeModel() {
  disposeSplatEraser();
  disposeSplatCrop();
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
 * Process a PLY or standard Splat buffer and load both available render modes.
 */
async function processBuffer(buffer, name, isFreshLoad = false) {
  // Cache raw buffer for quick reloading on settings changes
  state.lastLoadedBuffer = buffer;
  state.lastLoadedName = name;
  state.modelZoomScale = 1.0;
  state.initialZoomDist = null;
  state.keyframes = [];
  state.selectedKeyframeIndex = null;
  state.previewStart = null;
  state.cameraPathFirstFrame = null;
  state.restoreCameraPathFirstFrameOnOpen = false;
  if (isFreshLoad) {
    state.subjectCropBounds = null;
    state.settings.splatCropEnabled = false;
    state.settings.splatCropShape = 'ellipsoid';
    state.settings.splatCropRadiiScale = { x: 1, y: 1, z: 1 };
    state.settings.splatCropOffset = { x: 0, y: 0, z: 0 };
    updateCropToggleUI(dom.btnSplatCropToggle, state.settings.splatCropEnabled, 'splat');
    updateSplatCropShapeUI();
  }
  invalidateCustomCameraPath();
  if (state.cameraModeActive) {
    toggleCameraMode();
  } else {
    updateKeyframeUI();
  }
  // Clean up previous loaded model
  disposeModel();
  // 1. Ensure Spark 2.0 Engine is dynamically loaded on demand (prevents slow page loading)
  if (!state.sparkRenderer) {
    updateLoadingProgress(0.72, 'Loading rendering engine...');
    try {
      const sparkModule = await import('@sparkjsdev/spark');
      const {
        SparkRenderer,
        SplatMesh,
        SplatEdit,
        SplatEditSdf,
        SplatEditSdfType,
        SplatEditRgbaBlendMode,
        RgbaArray,
        dyno,
      } = sparkModule;
      state.sparkRenderer = new SparkRenderer({ renderer: state.renderer });
      state.scene.add(state.sparkRenderer);
      state.SplatMeshClass = SplatMesh;
      state.sparkCropApi = {
        SplatEdit,
        SplatEditSdf,
        SplatEditSdfType,
        SplatEditRgbaBlendMode,
      };
      state.sparkPainterApi = { RgbaArray, dyno };
    } catch (err) {
      console.error('Failed to load rendering engine dynamically:', err);
      showToast(`Failed to load rendering engine: ${err.message}`, 'error', 6000);
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
    const header = new TextDecoder('ascii').decode(new Uint8Array(buffer, 0, Math.min(3, buffer.byteLength)));
    const parseModel = header === 'ply' ? parsePLY : parseSplat;
    data = parseModel(buffer, (p) => {
      updateLoadingProgress(0.78 + p * 0.1, `Parsing: ${Math.round(p * 100)}%`);
    }, {
      maxParticles: state.settings.maxParticles,
      // Retain sampled particles once; particle background crop is applied
      // live in the GPU shader instead of rebuilding the model.
      cropOutliers: true,
      deferCropToGpu: true,
      cropFactor: state.settings.cropFactor,
      autoCropFactor: isFreshLoad,
      minOpacity: state.settings.minOpacity
    });

    const fallbackParticleCrop = analyzeParticleCropBounds(data.positions, data.count);
    const parserCropCenter = data.particleCropCenter;
    const parserCropRadius = data.particleCropRadius;
    const particleCrop = {
      center: (
        parserCropCenter
        && Number.isFinite(parserCropCenter.x)
        && Number.isFinite(parserCropCenter.y)
        && Number.isFinite(parserCropCenter.z)
      ) ? parserCropCenter : fallbackParticleCrop.center,
      radius: parserCropRadius > 0 ? parserCropRadius : fallbackParticleCrop.radius,
      recommendedFactor: Number.isFinite(data.recommendedCropFactor)
        ? data.recommendedCropFactor
        : fallbackParticleCrop.recommendedFactor,
    };
    data.particleCropCenter = particleCrop.center;
    data.particleCropRadius = particleCrop.radius;
    data.particleCropEnabled = state.settings.cropOutliers;
    data.particleCropFactor = state.settings.cropFactor;

    // Dynamically apply recommended crop factor for fresh model loads
    if (isFreshLoad) {
      const factor = THREE.MathUtils.clamp(particleCrop.recommendedFactor, 0.5, 3.0);
      state.settings.cropFactor = factor;
      data.particleCropFactor = factor;
      if (dom.settingCropFactor) {
        dom.settingCropFactor.value = factor.toFixed(2);
      }
      if (dom.settingCropFactorVal) {
        dom.settingCropFactorVal.textContent = `${factor.toFixed(2)}x`;
      }
    }
  } catch (err) {
    hideLoading();
    console.error(err);
    showToast(`Failed to parse model data: ${err.message}`, 'error');
    return;
  }
  // 3. Create Particle System
  updateLoadingProgress(0.88, 'Creating Particle Cloud...');
  const info = state.particleSystem.createFromData(data, state.scene);
  state.particleSystem.setViewportSize(window.innerWidth, window.innerHeight);
  state.particleSystem.setPointSize(state.settings.pointSize);
  state.particleSystem.setDensity(state.settings.pointDensity);
  state.particleSystem.setCropEnabled(state.settings.cropOutliers);
  state.particleSystem.setCropFactor(state.settings.cropFactor);
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
  updateLoadingProgress(0.92, 'Loading 3D Reality...');
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
        configureSplatCrop(mesh, data);
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
          state.camera.position.set(0, 0.15, 1.0);
        }
        state.controls.target.set(0, 0, 0);
        state.controls.update();
        state.isModelLoaded = true;
        state.rendererVisibility.particles = null;
        state.rendererVisibility.spark = null;
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
          updateLoadingProgress(0.92 + (event.loaded / event.total) * 0.07, `Rendering engine load: ${Math.round((event.loaded / event.total) * 100)}%`);
        }
      }
    });
    state.splatMesh = currentSplatMesh;
  } catch (err) {
    hideLoading();
    console.error(err);
    showToast(`Rendering engine load failed: ${err.message}`, 'error', 6000);
  }
}
// ============================================================
// Gesture Control
// ============================================================
const updateRemyPosition = () => {
  const panel = document.getElementById('remy-intro-panel');
  if (!panel || panel.style.display === 'none') return;
  
  const gap = 10;
  const previewControlsActive = document.body.classList.contains('preview-mode-active');
  const recordingControlsActive = document.body.classList.contains('recording-mode-active');
  const webcamActive = dom.webcamContainer && !dom.webcamContainer.classList.contains('hidden');
  const progressActive = dom.progressControl && dom.progressControl.classList.contains('visible');
  const mobileModelPage = isMobileViewport() && state.isModelLoaded;

  // Preview/export controls are fixed to the bottom edge on phones. Anchor the
  // Remy card above the top-most active control (including the progress bar)
  // so landscape screens and safe-area insets cannot make them overlap.
  if (previewControlsActive || recordingControlsActive) {
    const activeBottomControls = [];
    if (previewControlsActive && dom.previewControls) activeBottomControls.push(dom.previewControls);
    if (recordingControlsActive && dom.recordingControls) activeBottomControls.push(dom.recordingControls);
    if (progressActive && dom.progressControl) activeBottomControls.push(dom.progressControl);

    const controlTops = activeBottomControls
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => rect.top);

    if (controlTops.length > 0) {
      const topMostControl = Math.min(...controlTops);
      panel.style.setProperty('bottom', `${window.innerHeight - topMostControl + gap}px`, 'important');
      return;
    }
  }
  
  if (webcamActive) {
    // Position above the webcam container using its actual rendered height
    const wcRect = dom.webcamContainer.getBoundingClientRect();
    const viewH = window.innerHeight;
    const wcTop = wcRect.top; // top of webcam container relative to viewport
    panel.style.setProperty('bottom', (viewH - wcTop + gap) + 'px');
  } else if (progressActive) {
    const pcRect = dom.progressControl.getBoundingClientRect();
    const viewH = window.innerHeight;
    panel.style.setProperty(
      'bottom',
      (viewH - pcRect.top + gap) + 'px',
      mobileModelPage ? 'important' : ''
    );
  } else if (mobileModelPage) {
    const toolbar = document.getElementById('toolbar');
    const toolbarRect = toolbar?.getBoundingClientRect();
    if (toolbarRect && toolbarRect.width > 0 && toolbarRect.height > 0) {
      panel.style.setProperty(
        'bottom',
        (window.innerHeight - toolbarRect.top + gap) + 'px',
        'important'
      );
    } else {
      panel.style.removeProperty('bottom');
    }
  } else {
    panel.style.removeProperty('bottom');
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
    const gIconSpan = dom.btnGesture.querySelector('.btn-icon');
    const gTextSpan = dom.btnGesture.querySelector('.btn-text');
    setInlineIcon(gIconSpan, 'icon-hand-stop');
    if (gTextSpan) gTextSpan.textContent = state.lang === 'zh' ? '手势控制' : 'Gesture';
    dom.btnGesture.classList.remove('active');
    dom.webcamDot.classList.remove('active');
    if (dom.gestureIcon) dom.gestureIcon.textContent = '';
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
        
        const actIcon = dom.btnGesture.querySelector('.btn-icon');
        const actText = dom.btnGesture.querySelector('.btn-text');
        setInlineIcon(actIcon, 'icon-circle-check');
        if (actText) actText.textContent = state.lang === 'zh' ? '运行中' : 'Active';
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
  const gIconSpan = dom.btnGesture.querySelector('.btn-icon');
  const gTextSpan = dom.btnGesture.querySelector('.btn-text');
  setInlineIcon(gIconSpan, 'icon-loader', { spinning: true });
  if (gTextSpan) gTextSpan.textContent = state.lang === 'zh' ? '加载中...' : 'Loading...';
  dom.webcamContainer.classList.remove('hidden');
  updateRemyPositionDeferred();
  const success = await state.gestureControl.init(dom.webcamVideo);
  if (success) {
    state.isGestureActive = true;
    state.manualControl = false; // Reset manual control block immediately so gestures take effect!
    setInlineIcon(gIconSpan, 'icon-hand-stop');
    if (gTextSpan) gTextSpan.textContent = state.lang === 'zh' ? '手势控制' : 'Gesture';
    dom.btnGesture.classList.add('active');
  } else {
    setInlineIcon(gIconSpan, 'icon-hand-stop');
    if (gTextSpan) gTextSpan.textContent = state.lang === 'zh' ? '手势控制' : 'Gesture';
    dom.webcamContainer.classList.add('hidden');
    updateRemyPositionDeferred();
  }
}
// ============================================================
// Animation Loop
// ============================================================
function pauseRegularAnimationLoop() {
  state.compositingActive = true;
  if (state.animationFrameId !== null) {
    cancelAnimationFrame(state.animationFrameId);
    state.animationFrameId = null;
  }
}

function resumeRegularAnimationLoop() {
  if (!state.compositingActive) return;
  state.compositingActive = false;
  state.clock.getDelta();
  if (state.animationFrameId === null) {
    state.animationFrameId = requestAnimationFrame(animate);
  }
}

function animate() {
  state.animationFrameId = null;
  if (state.compositingActive) return;
  state.animationFrameId = requestAnimationFrame(animate);
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
  // Keep the model fixed throughout camera-path setup, preview and export.
  if (state.particleSystem) {
    const cameraFlowLocksRotation = state.cameraModeActive
      || state.previewActive
      || state.previewCompleted
      || state.recordingActive
      || state.exportPreparing
      || state.compositingActive;
    state.particleSystem.autoRotate = !state.rotationPaused && !cameraFlowLocksRotation;
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
    // Toggle 3DGS mode via the Victory gesture (state transition trigger with 0.7s hold threshold)
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
  if (state.previewActive) {
    setSparkPrewarmActive(false);
    applyRendererTimelineAtTime(
      state.previewTime,
      state.previewInitialRenderer,
      state.previewRendererTimeline
    );
  } else if (state.recordingActive) {
    setSparkPrewarmActive(shouldPrewarmSparkAtTime(
      state.recordTime,
      state.exportInitialRenderer,
      state.exportRendererTimeline,
      state.recordingFps
    ));
    applyRendererTimelineAtTime(
      state.recordTime,
      state.exportInitialRenderer,
      state.exportRendererTimeline
    );
  } else {
    setSparkPrewarmActive(false);
  }
  if (state.previewActive) {
    updateFlightGatherProgress(state.previewTime);
  } else if (state.recordingActive) {
    updateFlightGatherProgress(state.recordTime);
  }
  // Target interpolation based on renderer setting (no hand-open dissipation in Spark mode)
  state.splatInterpolationTarget = (state.settings.renderer === 'spark') ? 1.0 : 0.0;
  const transitionDirection = state.splatInterpolationTarget >= state.splatInterpolation ? 1.0 : -1.0;
  // Interpolate splat transition (0.0 to 1.0)
  const interpolationLerp = 0.04;
  state.splatInterpolation += (state.splatInterpolationTarget - state.splatInterpolation) * interpolationLerp;
  if (Math.abs(state.splatInterpolation - state.splatInterpolationTarget) < 0.001) {
    state.splatInterpolation = state.splatInterpolationTarget;
  }
  // Update rendering and interaction based on active engine
  if (state.isModelLoaded) {
    // 1. Update opacity of Spark SplatMesh (fade in as splatInterpolation goes to 1.0)
    if (state.splatMesh) {
      const splatOpacity = transitionDirection > 0
        ? Math.pow(state.splatInterpolation, 2.1)
        : Math.pow(state.splatInterpolation, 1.45);
      state.splatMesh.opacity = splatOpacity;
    }
    syncModelRendererVisibility();
    // 2. Update Particle System (fades out internally in shader)
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

    // 3. Synchronize the 3DGS pivot after auto-rotation has advanced. Copying the
    // previous frame's value made the default model rotation look sticky.
    if (state.splatPivot && state.particleSystem?.pivot) {
      state.splatPivot.rotation.y = state.particleSystem.pivot.rotation.y;
    }
  }
  // Camera Path Flight Animation (interpolates camera positions and targets)
  if (state.previewActive) {
    if (state.settings.presetFlight === 'none') {
      const totalDuration = getCurrentFlightDuration();
      state.previewTime = Math.min(state.previewTime + renderDelta, totalDuration);
      applyCurrentFlightProgress(state.previewTime / totalDuration);
      if (state.previewTime >= totalDuration) finishPreviewCycle();
    }
  } else if (state.recordingActive) {
    state.recordTime += renderDelta;
    const totalDuration = state.settings.presetFlight !== 'none'
      ? getPresetFlightDuration(state.settings.presetFlight)
      : (state.keyframes.length - 1) * CUSTOM_KEYFRAME_SEGMENT_DURATION;
    const flightProgress = Math.min(state.recordTime / totalDuration, 1);

    if (state.settings.presetFlight !== 'none') {
      applyPresetFlight(state.settings.presetFlight, flightProgress);
    } else {
      interpolateCamera(flightProgress);
    }
    
    if (state.recordTime >= totalDuration) {
      state.recordingActive = false;
      setSparkPrewarmActive(false);
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
  updateSplatCropHandleDepthOpacity();
  syncSplatEraserBrushCursor();
  // Render
  state.renderer.render(state.scene, state.camera);
}
// ============================================================
// Renderer Mode Toggle (Spark 2.0 vs Particles)
// ============================================================
function updateDesktopSettingsUI() {
  if (!dom.settingsPanel) return;
  const isSpark = state.settings.renderer === 'spark';
  dom.settingsPanel.classList.toggle('desktop-setting-spark', isSpark);
  for (const [button, selected] of [
    [dom.btnDesktopParticleSettings, !isSpark],
    [dom.btnDesktopSplatSettings, isSpark],
  ]) {
    if (!button) continue;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
}

function updateRendererUI() {
  if (!dom.btnToggleSpark) return;
  const iconSpan = dom.btnToggleSpark.querySelector('.btn-icon');
  const textSpan = dom.btnToggleSpark.querySelector('.btn-text');
  
  const dict = translations[state.lang];
  if (state.settings.renderer === 'spark') {
    dom.btnToggleSpark.classList.add('active');
    setInlineIcon(iconSpan, 'icon-sparkles');
    const text = dict ? dict['btn-spark-text'] : '3D Reality';
    if (textSpan) textSpan.textContent = text;
  } else {
    dom.btnToggleSpark.classList.remove('active');
    setInlineIcon(iconSpan, 'icon-atom');
    const text = dict ? dict['btn-pointcloud-text'] : 'Particle Mode';
    if (textSpan) textSpan.textContent = text;
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
  updateDesktopSettingsUI();
  updateMobileSettingsUI();
  syncSplatCropHelperVisibility();
}
function setRendererMode(mode, source = 'timeline') {
  if (mode !== 'particles' && mode !== 'spark') return;
  if (state.settings.renderer === mode) return;
  if (mode === 'particles' && state.splatEraser?.active) {
    setSplatEraserActive(false, { silent: true });
  }
  state.settings.renderer = mode;
  updateRendererUI();
  if (source === 'timeline' || source === 'composite') return;
  if (source === 'gesture') {
    if (mode === 'spark') {
      showToast(t('gesture-switched-spark'), 'success', 2000);
    } else {
      showToast(t('gesture-switched-cloud'), 'info', 2000);
    }
  } else {
    if (mode === 'spark') {
      showToast(t('spark-mode-enabled'), 'success', 2000);
    } else {
      showToast(t('point-cloud-enabled'), 'info', 2000);
    }
  }
}

function getRendererAtTime(time, initialRenderer, timeline = []) {
  let renderer = initialRenderer || state.settings.renderer;
  for (const event of timeline) {
    if (event.time > time + 0.0001) break;
    renderer = event.renderer;
  }
  return renderer;
}

function applyRendererTimelineAtTime(time, initialRenderer, timeline = []) {
  setRendererMode(getRendererAtTime(time, initialRenderer, timeline), 'timeline');
}

const SPARK_EXPORT_PREWARM_FRAMES = 6;

function shouldPrewarmSparkAtTime(
  time,
  initialRenderer,
  timeline = [],
  fps = EXPORT_FPS
) {
  if (getRendererAtTime(time, initialRenderer, timeline) === 'spark') return false;
  const prewarmDuration = SPARK_EXPORT_PREWARM_FRAMES / Math.max(1, fps);
  return timeline.some(event => (
    event.renderer === 'spark'
    && event.time > time + 0.0001
    && event.time - time <= prewarmDuration + 0.0001
  ));
}

function setSparkPrewarmActive(active) {
  const nextActive = Boolean(active);
  if (state.sparkPrewarmActive === nextActive) return;
  state.sparkPrewarmActive = nextActive;
  if (nextActive) {
    // Re-apply the latest crop matrix before Spark becomes visible. Crop
    // center/size remain model-edit data and never mutate camera-path state.
    updateSplatCropFromSettings();
  }
  state.rendererVisibility.spark = null;
  syncModelRendererVisibility();
}

function recordPreviewRendererSwitch(renderer) {
  const time = Math.max(0, Math.min(state.previewTime, getCurrentFlightDuration()));
  state.previewRendererTimeline = state.previewRendererTimeline.filter(
    event => event.time < time - 0.0001
  );
  const previousRenderer = getRendererAtTime(
    Math.max(0, time - 0.0002),
    state.previewInitialRenderer,
    state.previewRendererTimeline
  );
  if (previousRenderer !== renderer) {
    state.previewRendererTimeline.push({ time, renderer });
  }
}

function recordExportRendererSwitch(renderer) {
  const timeline = state.exportRendererTimeline;
  const time = Math.max(0, Math.min(state.recordTime, getCurrentFlightDuration()));
  const cutoffIndex = timeline.findIndex(event => event.time >= time - 0.0001);
  if (cutoffIndex >= 0) timeline.splice(cutoffIndex);
  const previousRenderer = getRendererAtTime(
    Math.max(0, time - 0.0002),
    state.exportInitialRenderer,
    timeline
  );
  if (previousRenderer !== renderer) timeline.push({ time, renderer });
}

function toggleRendererMode(source = 'gesture') {
  const newMode = state.settings.renderer === 'spark' ? 'particles' : 'spark';
  setRendererMode(newMode, source);
  if (source === 'preview' && state.previewActive) {
    recordPreviewRendererSwitch(newMode);
  } else if (source === 'recording' && state.recordingActive) {
    recordExportRendererSwitch(newMode);
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
  if (state.splatEraser?.active) setSplatEraserActive(false, { silent: true });
  
  state.cameraModeActive = !state.cameraModeActive;
  dom.btnCameraMode.classList.toggle('active', state.cameraModeActive);
  dom.cameraPathPanel.classList.toggle('hidden', !state.cameraModeActive);
  document.body.classList.toggle('camera-path-active', state.cameraModeActive);
  
  if (state.cameraModeActive) {
    // Hide settings panel if open
    dom.settingsPanel.classList.add('hidden');
    dom.btnSettings.classList.remove('active');
    document.body.classList.remove('settings-panel-active');
    syncSplatCropHelperVisibility();
    
    // Pause auto-rotation immediately
    if (state.particleSystem) {
      state.particleSystem.autoRotate = false;
    }
    restoreRememberedCameraPathFirstFrame();
    showToast('Camera Path Mode active: Adjust view and record keyframes!', 'success');
  } else {
    // Restore autoRotate
    if (state.particleSystem) {
      state.particleSystem.autoRotate = !state.rotationPaused;
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
  restoreRememberedCameraPathFirstFrame();
}
const MOBILE_MAX_KEYFRAMES = 10;
const CUSTOM_KEYFRAME_SEGMENT_DURATION = 2.0;

function getKeyframeLimit() {
  return IS_PHONE_DEVICE ? MOBILE_MAX_KEYFRAMES : Infinity;
}

function invalidateCustomCameraPath() {
  state.cameraKeyframeTimes = null;
  state.cameraSphericalPoints = null;
  state.cameraSphericalVelocities = null;
  state.cameraFilteredTargets = null;
  state.cameraTargetVelocities = null;
  state.cameraProjectionValues = null;
  state.cameraProjectionVelocities = null;
  state.cameraQuaternions = null;
  state.cameraQuaternionControls = null;
  state.cameraModelQuaternions = null;
  state.cameraModelQuaternionControls = null;
  state.cameraMotionProgress = null;
  state.cameraMotionDistances = null;
  state.cameraMotionTotal = 0;
}

function addKeyframe() {
  if (!state.isModelLoaded) return;
  const keyframeLimit = getKeyframeLimit();
  if (state.keyframes.length >= keyframeLimit) {
    showToast(t('max-keyframes-allowed'), 'warning');
    return;
  }
  
  state.keyframes.push(captureCurrentCameraPathFrame());
  state.selectedKeyframeIndex = state.keyframes.length - 1;

  invalidateCustomCameraPath();
  updateKeyframeUI();
  showToast(`Keyframe ${state.keyframes.length} recorded!`, 'success');
}
function clearKeyframes() {
  state.keyframes = [];
  state.selectedKeyframeIndex = null;
  invalidateCustomCameraPath();
  updateKeyframeUI();
  showToast('All keyframes cleared', 'info');
}
function updateKeyframeUI() {
  dom.keyframeList.innerHTML = '';
  
  state.keyframes.forEach((kf, i) => {
    const item = document.createElement('div');
    item.className = 'keyframe-item';
    item.classList.toggle('selected', state.selectedKeyframeIndex === i);
    item.setAttribute('aria-current', state.selectedKeyframeIndex === i ? 'true' : 'false');
    
    const jumpButton = document.createElement('button');
    jumpButton.type = 'button';
    jumpButton.className = 'keyframe-jump';
    jumpButton.textContent = `${state.lang === 'zh' ? '视角' : 'Viewpoint'} ${i + 1}`;
    jumpButton.title = state.lang === 'zh'
      ? `跳转到视角 ${i + 1}`
      : `Go to viewpoint ${i + 1}`;
    jumpButton.setAttribute('aria-pressed', state.selectedKeyframeIndex === i ? 'true' : 'false');
    jumpButton.addEventListener('click', () => jumpToKeyframe(i));
    item.appendChild(jumpButton);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove keyframe';
    removeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      removeKeyframe(i);
    });
    item.appendChild(removeBtn);
    
    dom.keyframeList.appendChild(item);
  });

  requestAnimationFrame(() => {
    dom.keyframeList.scrollLeft = dom.keyframeList.scrollWidth;
  });
  
  dom.keyframeCount.textContent = state.keyframes.length;
  if (dom.keyframeLimit) {
    dom.keyframeLimit.textContent = Number.isFinite(getKeyframeLimit())
      ? `/${getKeyframeLimit()}`
      : '';
  }
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

function updateSelectedKeyframeUI() {
  Array.from(dom.keyframeList.children).forEach((item, index) => {
    const selected = state.selectedKeyframeIndex === index;
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-current', selected ? 'true' : 'false');
    item.querySelector('.keyframe-jump')?.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
}

function jumpToKeyframe(index) {
  const frame = state.keyframes[index];
  if (!frame || state.previewActive || state.recordingActive || state.compositingActive) return;
  applyCameraPathFrame(frame);
  state.selectedKeyframeIndex = index;
  updateSelectedKeyframeUI();
  showToast(
    state.lang === 'zh' ? `已跳转到视角 ${index + 1}` : `Viewpoint ${index + 1} restored`,
    'info',
    1800
  );
}

function removeKeyframe(index) {
  state.keyframes.splice(index, 1);
  if (state.selectedKeyframeIndex === index) {
    state.selectedKeyframeIndex = null;
  } else if (state.selectedKeyframeIndex > index) {
    state.selectedKeyframeIndex -= 1;
  }
  invalidateCustomCameraPath();
  updateKeyframeUI();
  showToast('Keyframe removed', 'info');
}

function createMonotoneTimeDerivatives(values, times) {
  const pointCount = values.length;
  const derivatives = new Array(pointCount).fill(0);
  if (pointCount < 2) return derivatives;
  if (pointCount === 2) {
    const duration = Math.max(1e-6, times[1] - times[0]);
    const slope = (values[1] - values[0]) / duration;
    derivatives[0] = slope;
    derivatives[1] = slope;
    return derivatives;
  }

  const intervals = new Array(pointCount - 1);
  const slopes = new Array(pointCount - 1);
  for (let index = 0; index < pointCount - 1; index++) {
    intervals[index] = Math.max(1e-6, times[index + 1] - times[index]);
    slopes[index] = (values[index + 1] - values[index]) / intervals[index];
  }

  // Smooth Catmull-Rom weighted velocity calculation (prevents zero-velocity stalls at keyframes)
  for (let index = 1; index < pointCount - 1; index++) {
    const previousSlope = slopes[index - 1];
    const nextSlope = slopes[index];
    const previousInterval = intervals[index - 1];
    const nextInterval = intervals[index];
    const totalInterval = previousInterval + nextInterval;
    
    // Continuous velocity vector through keyframe node
    derivatives[index] = (previousSlope * nextInterval + nextSlope * previousInterval) / totalInterval;
  }

  // Endpoints: smooth natural extension
  derivatives[0] = slopes[0] - (derivatives[1] - slopes[0]) * 0.5;
  derivatives[pointCount - 1] = slopes[pointCount - 2] + (slopes[pointCount - 2] - derivatives[pointCount - 2]) * 0.5;

  return derivatives;
}

function createVectorTimeDerivatives(points, times) {
  const xDerivatives = createMonotoneTimeDerivatives(points.map(point => point.x), times);
  const yDerivatives = createMonotoneTimeDerivatives(points.map(point => point.y), times);
  const zDerivatives = createMonotoneTimeDerivatives(points.map(point => point.z), times);
  return points.map((_, index) => new THREE.Vector3(
    xDerivatives[index],
    yDerivatives[index],
    zDerivatives[index]
  ));
}

const cameraTimelineSample = { segmentIndex: 0, amount: 0, duration: 1 };

function getCameraTimelineSegment(progress) {
  const times = state.cameraKeyframeTimes;
  const clampedProgress = THREE.MathUtils.clamp(progress, 0, 1);
  if (!times?.length || times.length < 2) {
    cameraTimelineSample.segmentIndex = 0;
    cameraTimelineSample.amount = clampedProgress;
    cameraTimelineSample.duration = 1;
    return cameraTimelineSample;
  }

  let low = 0;
  let high = times.length - 2;
  while (low < high) {
    const middle = Math.floor((low + high) * 0.5);
    if (clampedProgress > times[middle + 1]) low = middle + 1;
    else high = middle;
  }
  const segmentIndex = low;
  const duration = Math.max(1e-6, times[segmentIndex + 1] - times[segmentIndex]);
  cameraTimelineSample.segmentIndex = segmentIndex;
  cameraTimelineSample.amount = clampedProgress >= 1
    ? 1
    : THREE.MathUtils.clamp((clampedProgress - times[segmentIndex]) / duration, 0, 1);
  cameraTimelineSample.duration = duration;
  return cameraTimelineSample;
}

function interpolateQuinticScalar(values, derivatives, segmentIndex, amount, duration) {
  const amount2 = amount * amount;
  const amount3 = amount2 * amount;
  const position0 = 1 - 3 * amount2 + 2 * amount3;
  const velocity0 = amount - 2 * amount2 + amount3;
  const position1 = 3 * amount2 - 2 * amount3;
  const velocity1 = -amount2 + amount3;
  return position0 * values[segmentIndex]
    + velocity0 * duration * derivatives[segmentIndex]
    + position1 * values[segmentIndex + 1]
    + velocity1 * duration * derivatives[segmentIndex + 1];
}

function interpolateQuinticVector(points, derivatives, segmentIndex, amount, duration, output = new THREE.Vector3()) {
  const amount2 = amount * amount;
  const amount3 = amount2 * amount;
  const position0 = 1 - 3 * amount2 + 2 * amount3;
  const velocity0 = amount - 2 * amount2 + amount3;
  const position1 = 3 * amount2 - 2 * amount3;
  const velocity1 = -amount2 + amount3;
  return output
    .copy(points[segmentIndex]).multiplyScalar(position0)
    .addScaledVector(derivatives[segmentIndex], velocity0 * duration)
    .addScaledVector(points[segmentIndex + 1], position1)

    .addScaledVector(derivatives[segmentIndex + 1], velocity1 * duration);
}

function sphericalPointToCameraPosition(sphereCoords, target, output = new THREE.Vector3()) {
  const spherical = new THREE.Spherical(
    Math.max(1e-5, sphereCoords.x),
    THREE.MathUtils.clamp(sphereCoords.z, 1e-4, Math.PI - 1e-4),
    sphereCoords.y
  );
  return output.setFromSpherical(spherical).add(target);
}

const CAMERA_TARGET_FILTER_PIXELS = 14;
const CAMERA_TIMELINE_BASELINE_RATIO = 0.08;

function buildFilteredCameraTargets() {
  const viewportHeight = Math.max(
    1,
    state.renderer?.domElement?.getBoundingClientRect?.().height || window.innerHeight || 1
  );
  const filteredTargets = [state.keyframes[0].target.clone()];

  for (let index = 1; index < state.keyframes.length; index++) {
    const frame = state.keyframes[index];
    const previousFrame = state.keyframes[index - 1];
    const savedDirection = frame.target.clone().sub(frame.position);
    const previousDirection = previousFrame.target.clone().sub(frame.position);
    if (savedDirection.lengthSq() < 1e-12 || previousDirection.lengthSq() < 1e-12) {
      filteredTargets.push(frame.target.clone());
      continue;
    }

    savedDirection.normalize();
    previousDirection.normalize();
    const angle = savedDirection.angleTo(previousDirection);
    const fovRadians = THREE.MathUtils.degToRad(
      Number.isFinite(frame.fov) ? frame.fov : (state.camera?.fov || 60)
    );
    const focalPixels = viewportHeight / (2 * Math.tan(Math.max(0.01, fovRadians) * 0.5));
    const screenShift = 2 * Math.tan(angle * 0.5) * focalPixels;

    filteredTargets.push(
      screenShift <= CAMERA_TARGET_FILTER_PIXELS
        ? filteredTargets[index - 1].clone()
        : frame.target.clone()
    );
  }
  return filteredTargets;
}

function getFrameProjectionScale(frame) {
  const fov = Number.isFinite(frame?.fov) ? frame.fov : 60;
  const zoom = Number.isFinite(frame?.zoom) ? frame.zoom : 1;
  return Math.max(1e-6, zoom / Math.tan(THREE.MathUtils.degToRad(fov) * 0.5));
}

function getQuaternionAngularDistance(startQuaternion, endQuaternion) {
  if (!startQuaternion || !endQuaternion) return 0;
  const dot = THREE.MathUtils.clamp(Math.abs(startQuaternion.dot(endQuaternion)), 0, 1);
  return 2 * Math.acos(dot);
}

function buildDynamicCameraTimeline(filteredTargets, cameraQuaternions, modelQuaternions) {
  const segmentMotions = [];
  for (let index = 0; index < state.keyframes.length - 1; index++) {
    const startFrame = state.keyframes[index];
    const endFrame = state.keyframes[index + 1];
    const startTarget = filteredTargets[index];
    const endTarget = filteredTargets[index + 1];
    const startRadius = startFrame.position.distanceTo(startTarget);
    const endRadius = endFrame.position.distanceTo(endTarget);
    const averageRadius = Math.max(1e-4, (startRadius + endRadius) * 0.5);
    const positionMotion = startFrame.position.distanceTo(endFrame.position);
    const targetMotion = startTarget.distanceTo(endTarget) * 0.6;
    const cameraRotationMotion = averageRadius
      * getQuaternionAngularDistance(cameraQuaternions[index], cameraQuaternions[index + 1])
      * 0.75;
    const modelRotationMotion = averageRadius
      * getQuaternionAngularDistance(modelQuaternions[index], modelQuaternions[index + 1])
      * 0.35;
    const projectionMotion = averageRadius
      * Math.abs(Math.log(getFrameProjectionScale(endFrame) / getFrameProjectionScale(startFrame)))
      * 0.5;
    segmentMotions.push(Math.max(1e-6, Math.hypot(
      positionMotion,
      targetMotion,
      cameraRotationMotion,
      modelRotationMotion,
      projectionMotion
    )));
  }

  const averageMotion = segmentMotions.reduce((sum, motion) => sum + motion, 0)
    / Math.max(1, segmentMotions.length);
  const baselineMotion = Math.max(1e-6, averageMotion * CAMERA_TIMELINE_BASELINE_RATIO);
  const weightedMotions = segmentMotions.map(motion => motion + baselineMotion);
  const totalMotion = weightedMotions.reduce((sum, motion) => sum + motion, 0);
  const times = [0];
  let elapsedMotion = 0;
  for (const motion of weightedMotions) {
    elapsedMotion += motion;
    times.push(elapsedMotion / totalMotion);
  }
  times[times.length - 1] = 1;
  return times;
}

function cloneContinuousCameraQuaternions(property) {
  const yAxis = new THREE.Vector3(0, 1, 0);
  const quaternions = state.keyframes.map(frame => {
    const savedQuaternion = frame[property];
    if (savedQuaternion) return savedQuaternion.clone().normalize();
    if (property === 'modelQuaternion') {
      return new THREE.Quaternion().setFromAxisAngle(yAxis, frame.modelRotationY || 0);
    }
    return new THREE.Quaternion();
  });
  for (let index = 1; index < quaternions.length; index++) {
    if (quaternions[index - 1].dot(quaternions[index]) < 0) {
      const quaternion = quaternions[index];
      quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w);
    }
  }
  return quaternions;
}

function quaternionLogVector(quaternion, output = new THREE.Vector3()) {
  const halfAngle = Math.acos(THREE.MathUtils.clamp(quaternion.w, -1, 1));
  const sinHalfAngle = Math.sin(halfAngle);
  if (Math.abs(sinHalfAngle) <= 1e-8) {
    return output.set(quaternion.x, quaternion.y, quaternion.z);
  }
  return output.set(quaternion.x, quaternion.y, quaternion.z)
    .multiplyScalar(halfAngle / sinHalfAngle);
}

function quaternionExpVector(vector, output = new THREE.Quaternion()) {
  const halfAngle = vector.length();
  if (halfAngle <= 1e-8) {
    return output.set(vector.x, vector.y, vector.z, 1).normalize();
  }
  const scale = Math.sin(halfAngle) / halfAngle;
  return output.set(
    vector.x * scale,
    vector.y * scale,
    vector.z * scale,
    Math.cos(halfAngle)
  ).normalize();
}

function createSquadControls(quaternions) {
  const controls = quaternions.map(quaternion => quaternion.clone());
  const previousRelative = new THREE.Quaternion();
  const nextRelative = new THREE.Quaternion();
  const previousLog = new THREE.Vector3();
  const nextLog = new THREE.Vector3();
  const exponent = new THREE.Quaternion();

  for (let index = 1; index < quaternions.length - 1; index++) {
    const inverseCurrent = quaternions[index].clone().invert();
    previousRelative.copy(inverseCurrent).multiply(quaternions[index - 1]);
    nextRelative.copy(inverseCurrent).multiply(quaternions[index + 1]);
    quaternionLogVector(previousRelative, previousLog);
    quaternionLogVector(nextRelative, nextLog);
    previousLog.add(nextLog).multiplyScalar(-0.25);
    quaternionExpVector(previousLog, exponent);
    controls[index].copy(quaternions[index]).multiply(exponent).normalize();
    if (controls[index].dot(quaternions[index]) < 0) {
      const control = controls[index];
      control.set(-control.x, -control.y, -control.z, -control.w);
    }
  }
  return controls;
}

const cameraSquadStart = new THREE.Quaternion();
const cameraSquadControl = new THREE.Quaternion();
const cameraSplineSphere = new THREE.Vector3();
const cameraSplineTarget = new THREE.Vector3();
const cameraSplinePosition = new THREE.Vector3();
const cameraSplineQuaternion = new THREE.Quaternion();
const cameraSplineModelQuaternion = new THREE.Quaternion();
const cameraMotionPreviousPosition = new THREE.Vector3();
const cameraMotionCurrentPosition = new THREE.Vector3();
const cameraMotionPreviousTarget = new THREE.Vector3();
const cameraMotionCurrentTarget = new THREE.Vector3();
const cameraMotionPreviousQuaternion = new THREE.Quaternion();
const cameraMotionCurrentQuaternion = new THREE.Quaternion();
const cameraMotionPreviousModelQuaternion = new THREE.Quaternion();
const cameraMotionCurrentModelQuaternion = new THREE.Quaternion();

function interpolateSquad(quaternions, controls, segmentIndex, amount, output = new THREE.Quaternion()) {
  cameraSquadStart.copy(quaternions[segmentIndex]).slerp(quaternions[segmentIndex + 1], amount);
  cameraSquadControl.copy(controls[segmentIndex]).slerp(controls[segmentIndex + 1], amount);
  return output.copy(cameraSquadStart)
    .slerp(cameraSquadControl, 2 * amount * (1 - amount))
    .normalize();
}

function easeCameraPathStart(value) {
  const value2 = value * value;
  const value3 = value2 * value;
  const value4 = value3 * value;
  const value5 = value4 * value;
  return 3 * value5 - 8 * value4 + 6 * value3;
}

const CAMERA_ENDPOINT_EASE_PORTION = 0.12;
const CAMERA_MOTION_SAMPLES_PER_SEGMENT = 192;

function getGlobalCameraTimeProgress(progress) {
  const clampedProgress = THREE.MathUtils.clamp(progress, 0, 1);
  if (clampedProgress < CAMERA_ENDPOINT_EASE_PORTION) {
    const localProgress = clampedProgress / CAMERA_ENDPOINT_EASE_PORTION;
    return CAMERA_ENDPOINT_EASE_PORTION * easeCameraPathStart(localProgress);
  }
  if (clampedProgress > 1 - CAMERA_ENDPOINT_EASE_PORTION) {
    const localProgress = (1 - clampedProgress) / CAMERA_ENDPOINT_EASE_PORTION;
    return 1 - CAMERA_ENDPOINT_EASE_PORTION * easeCameraPathStart(localProgress);
  }
  return clampedProgress;
}

function sampleCameraSpline(
  progress,
  positionOutput,
  targetOutput,
  cameraQuaternionOutput,
  modelQuaternionOutput
) {
  const { segmentIndex, amount, duration } = getCameraTimelineSegment(progress);
  const sphereCoords = interpolateQuinticVector(
    state.cameraSphericalPoints,
    state.cameraSphericalVelocities,
    segmentIndex,
    amount,
    duration,
    cameraSplineSphere
  );
  interpolateQuinticVector(
    state.cameraFilteredTargets,
    state.cameraTargetVelocities,
    segmentIndex,
    amount,
    duration,
    targetOutput
  );
  sphericalPointToCameraPosition(sphereCoords, targetOutput, positionOutput);
  interpolateSquad(
    state.cameraQuaternions,
    state.cameraQuaternionControls,
    segmentIndex,
    amount,
    cameraQuaternionOutput
  );
  interpolateSquad(
    state.cameraModelQuaternions,
    state.cameraModelQuaternionControls,
    segmentIndex,
    amount,
    modelQuaternionOutput
  );
  return cameraTimelineSample;
}

function sampleCameraProjectionScale(progress) {
  const { segmentIndex, amount, duration } = getCameraTimelineSegment(progress);
  const fov = interpolateQuinticScalar(
    state.cameraProjectionValues.fov,
    state.cameraProjectionVelocities.fov,
    segmentIndex,
    amount,
    duration
  );
  const zoom = interpolateQuinticScalar(
    state.cameraProjectionValues.zoom,
    state.cameraProjectionVelocities.zoom,
    segmentIndex,
    amount,
    duration
  );
  return Math.max(1e-6, zoom / Math.tan(THREE.MathUtils.degToRad(fov) * 0.5));
}

function buildCameraMotionTable() {
  const segmentCount = Math.max(1, state.keyframes.length - 1);
  const sampleCount = Math.min(
    32768,
    Math.max(384, segmentCount * CAMERA_MOTION_SAMPLES_PER_SEGMENT)
  );
  const progressSamples = new Float32Array(sampleCount + 1);
  const cumulativeDistances = new Float64Array(sampleCount + 1);

  sampleCameraSpline(
    0,
    cameraMotionPreviousPosition,
    cameraMotionPreviousTarget,
    cameraMotionPreviousQuaternion,
    cameraMotionPreviousModelQuaternion
  );
  let previousProjectionScale = sampleCameraProjectionScale(0);
  let totalMotion = 0;

  for (let sampleIndex = 1; sampleIndex <= sampleCount; sampleIndex++) {
    const progress = sampleIndex / sampleCount;
    sampleCameraSpline(
      progress,
      cameraMotionCurrentPosition,
      cameraMotionCurrentTarget,
      cameraMotionCurrentQuaternion,
      cameraMotionCurrentModelQuaternion
    );
    const projectionScale = sampleCameraProjectionScale(progress);
    const radius = Math.max(
      1e-4,
      cameraMotionCurrentPosition.distanceTo(cameraMotionCurrentTarget)
    );
    const positionMotion = cameraMotionCurrentPosition.distanceTo(cameraMotionPreviousPosition);
    const targetMotion = cameraMotionCurrentTarget.distanceTo(cameraMotionPreviousTarget) * 0.6;
    const cameraRotationMotion = radius
      * getQuaternionAngularDistance(cameraMotionPreviousQuaternion, cameraMotionCurrentQuaternion)
      * 0.75;
    const modelRotationMotion = radius
      * getQuaternionAngularDistance(cameraMotionPreviousModelQuaternion, cameraMotionCurrentModelQuaternion)
      * 0.35;
    const projectionMotion = radius
      * Math.abs(Math.log(projectionScale / previousProjectionScale))
      * 0.5;
    totalMotion += Math.hypot(
      positionMotion,
      targetMotion,
      cameraRotationMotion,
      modelRotationMotion,
      projectionMotion
    );
    progressSamples[sampleIndex] = progress;
    cumulativeDistances[sampleIndex] = totalMotion;
    cameraMotionPreviousPosition.copy(cameraMotionCurrentPosition);
    cameraMotionPreviousTarget.copy(cameraMotionCurrentTarget);
    cameraMotionPreviousQuaternion.copy(cameraMotionCurrentQuaternion);
    cameraMotionPreviousModelQuaternion.copy(cameraMotionCurrentModelQuaternion);
    previousProjectionScale = projectionScale;
  }

  state.cameraMotionProgress = progressSamples;
  state.cameraMotionDistances = cumulativeDistances;
  state.cameraMotionTotal = totalMotion;
}

function getCameraProgressAtMotion(progress) {
  const progressSamples = state.cameraMotionProgress;
  const cumulativeDistances = state.cameraMotionDistances;
  const totalMotion = state.cameraMotionTotal;
  const clampedProgress = THREE.MathUtils.clamp(progress, 0, 1);
  if (!progressSamples?.length || !cumulativeDistances?.length || totalMotion <= 1e-8) {
    return clampedProgress;
  }
  if (clampedProgress <= 0) return 0;
  if (clampedProgress >= 1) return 1;

  const targetDistance = clampedProgress * totalMotion;
  let low = 1;
  let high = cumulativeDistances.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) * 0.5);
    if (cumulativeDistances[middle] < targetDistance) low = middle + 1;
    else high = middle;
  }
  const endIndex = low;
  const startIndex = endIndex - 1;
  const startDistance = cumulativeDistances[startIndex];
  const distanceSpan = cumulativeDistances[endIndex] - startDistance;
  if (distanceSpan <= 1e-10) return progressSamples[endIndex];
  const amount = (targetDistance - startDistance) / distanceSpan;
  return THREE.MathUtils.lerp(progressSamples[startIndex], progressSamples[endIndex], amount);
}

function initCameraCurves() {
  if (state.keyframes.length < 2) return false;
  
  const positions = state.keyframes.map(frame => frame.position.clone());
  const targets = buildFilteredCameraTargets();
  const cameraQuaternions = cloneContinuousCameraQuaternions('quaternion');
  const modelQuaternions = cloneContinuousCameraQuaternions('modelQuaternion');

  // Centripetal Catmull-Rom 3D curves ensure 100% continuous spatial velocity without knot stalls or overshoots
  state.cameraPositionCurve = new THREE.CatmullRomCurve3(positions, false, 'centripetal');
  state.cameraTargetCurve = new THREE.CatmullRomCurve3(targets, false, 'centripetal');
  state.cameraQuaternions = cameraQuaternions;
  state.cameraQuaternionControls = createSquadControls(cameraQuaternions);
  state.cameraModelQuaternions = modelQuaternions;
  state.cameraModelQuaternionControls = createSquadControls(modelQuaternions);

  // Compute keyframe arc-length parameters u_i along position curve for orientation and projection synchronization
  const numKeyframes = state.keyframes.length;
  const keyframeU = [0];
  const curveLengths = state.cameraPositionCurve.getLengths(Math.max(200, numKeyframes * 100));
  const totalLength = curveLengths[curveLengths.length - 1] || 1;

  for (let i = 1; i < numKeyframes; i++) {
    const fraction = i / (numKeyframes - 1);
    keyframeU.push(fraction);
  }
  state.cameraKeyframeU = keyframeU;
  return true;
}

function interpolateCamera(pct) {
  if (!state.cameraPositionCurve || !state.cameraTargetCurve) return;

  // Global ease-in at flight start (t=0) and ease-out at flight end (t=1)
  const progress = getGlobalCameraTimeProgress(pct);

  // 1. Sample 3D position and lookAt target at constant spatial speed
  state.cameraPositionCurve.getPointAt(progress, state.camera.position);
  state.cameraTargetCurve.getPointAt(progress, state.controls.target);

  // 2. Determine keyframe segment for quaternions and FOV/Zoom projection
  const numSegments = state.keyframes.length - 1;
  let segmentIndex = 0;
  let amount = 0;

  if (progress <= 0) {
    segmentIndex = 0;
    amount = 0;
  } else if (progress >= 1) {
    segmentIndex = numSegments - 1;
    amount = 1;
  } else {
    const rawSeg = progress * numSegments;
    segmentIndex = Math.min(numSegments - 1, Math.floor(rawSeg));
    amount = rawSeg - segmentIndex;
  }

  const startFrame = state.keyframes[segmentIndex];
  const endFrame = state.keyframes[segmentIndex + 1];

  // 3. Set camera rotation / quaternion
  if (startFrame.quaternion && endFrame.quaternion && state.cameraQuaternions) {
    interpolateSquad(
      state.cameraQuaternions,
      state.cameraQuaternionControls,
      segmentIndex,
      amount,
      state.camera.quaternion
    );
  } else {
    state.camera.lookAt(state.controls.target);
  }

  // Up vector interpolation
  if (startFrame.up && endFrame.up) {
    state.camera.up.lerpVectors(startFrame.up, endFrame.up, amount).normalize();
  }

  // 4. Smooth FOV / Zoom / Near / Far projection interpolation
  let projectionChanged = false;
  for (const property of ['fov', 'zoom', 'near', 'far']) {
    if (!Number.isFinite(startFrame[property]) || !Number.isFinite(endFrame[property])) continue;
    const smoothAmount = amount * amount * (3 - 2 * amount);
    const nextValue = THREE.MathUtils.lerp(startFrame[property], endFrame[property], smoothAmount);
    if (Math.abs(state.camera[property] - nextValue) > 1e-7) {
      state.camera[property] = nextValue;
      projectionChanged = true;
    }
  }
  if (projectionChanged) state.camera.updateProjectionMatrix();

  // 5. Model pivot rotation
  if (state.cameraModelQuaternions) {
    const modelQ = new THREE.Quaternion();
    interpolateSquad(
      state.cameraModelQuaternions,
      state.cameraModelQuaternionControls,
      segmentIndex,
      amount,
      modelQ
    );
    const modelPivots = [state.particleSystem?.pivot, state.splatPivot];
    for (const pivot of modelPivots) {
      if (pivot) pivot.quaternion.copy(modelQ);
    }
  }
}

/**
 * Apply dynamic preset camera flight based on Frustum Fitting math,
 * relative to user's real-time focus target.
 */
function getPresetFlightDuration(presetName) {
  return presetName === 'verticalLoop' ? 16.0 : 14.0;
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
  let cameraRoll = 0;
  
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

    case 'inceptionPush': {
      // Inception-style dolly: ease forward along the current line of sight while
      // the image plane slowly rolls. Keeping theta/phi fixed avoids turning this
      // into another orbit and preserves the user's chosen composition.
      const eased = t * t * (3 - 2 * t);
      r = r0 * (1.0 - 0.5 * eased);
      p = phi0;
      th = theta0;
      cameraRoll = 2 * Math.PI * eased;
      break;
    }
      
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
  if (cameraRoll !== 0) state.camera.rotateZ(cameraRoll);
  
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

function cloneCameraPathFrame(frame) {
  if (!frame) return null;
  return {
    position: frame.position.clone(),
    target: frame.target.clone(),
    fov: frame.fov,
    zoom: frame.zoom,
    near: frame.near,
    far: frame.far,
    up: frame.up?.clone?.() || null,
    quaternion: frame.quaternion?.clone?.() || null,
    modelQuaternion: frame.modelQuaternion?.clone?.() || null,
    modelRotationY: Number.isFinite(frame.modelRotationY) ? frame.modelRotationY : 0,
  };
}

function captureCurrentCameraPathFrame() {
  const modelPivot = state.particleSystem?.pivot || state.splatPivot;
  return {
    position: state.camera.position.clone(),
    target: state.controls.target.clone(),
    fov: state.camera.fov,
    zoom: state.camera.zoom,
    near: state.camera.near,
    far: state.camera.far,
    up: state.camera.up.clone(),
    quaternion: state.camera.quaternion.clone(),
    modelQuaternion: modelPivot?.quaternion?.clone?.() || null,
    modelRotationY: modelPivot?.rotation.y ?? 0,
  };
}

function applyCameraPathFrame(frame) {
  if (!frame) return;
  if (state.particleSystem) state.particleSystem.autoRotate = false;

  [state.particleSystem?.pivot, state.splatPivot].forEach((pivot) => {
    if (!pivot) return;
    if (frame.modelQuaternion) {
      pivot.quaternion.copy(frame.modelQuaternion);
    } else {
      pivot.rotation.y = frame.modelRotationY || 0;
    }
  });

  state.camera.position.copy(frame.position);
  state.controls.target.copy(frame.target);
  if (Number.isFinite(frame.fov)) state.camera.fov = frame.fov;
  if (Number.isFinite(frame.zoom)) state.camera.zoom = frame.zoom;
  if (Number.isFinite(frame.near)) state.camera.near = frame.near;
  if (Number.isFinite(frame.far)) state.camera.far = frame.far;
  if (frame.up) state.camera.up.copy(frame.up);
  state.camera.updateProjectionMatrix();

  // Flush any remaining damping delta from the user's previous drag, then
  // reapply every saved value so neither damping nor a pending pan can offset
  // the recalled frame by a fraction of a pixel.
  const dampingEnabled = state.controls.enableDamping;
  state.controls.enableDamping = false;
  state.controls.update();
  state.controls.enableDamping = dampingEnabled;

  state.camera.position.copy(frame.position);
  state.controls.target.copy(frame.target);
  if (Number.isFinite(frame.fov)) state.camera.fov = frame.fov;
  if (Number.isFinite(frame.zoom)) state.camera.zoom = frame.zoom;
  if (Number.isFinite(frame.near)) state.camera.near = frame.near;
  if (Number.isFinite(frame.far)) state.camera.far = frame.far;
  if (frame.up) state.camera.up.copy(frame.up);
  if (frame.quaternion) state.camera.quaternion.copy(frame.quaternion);
  state.camera.updateProjectionMatrix();
  state.camera.updateMatrixWorld(true);
}

function rememberCameraPathFirstFrame(frame) {
  state.cameraPathFirstFrame = cloneCameraPathFrame(frame);
  state.previewStart = cloneCameraPathFrame(frame);
}

function capturePreviewStart() {
  rememberCameraPathFirstFrame(captureCurrentCameraPathFrame());
}

function restorePreviewCameraStart() {
  if (!state.previewStart) return;
  applyCameraPathFrame(state.previewStart);
}

function restoreRememberedCameraPathFirstFrame() {
  if (!state.restoreCameraPathFirstFrameOnOpen || !state.cameraPathFirstFrame) return;
  state.previewStart = cloneCameraPathFrame(state.cameraPathFirstFrame);
  restorePreviewCameraStart();
  state.restoreCameraPathFirstFrameOnOpen = false;
}

function setPreviewControlsActive(active) {
  document.body.classList.toggle('preview-mode-active', active);
  updateRemyPositionDeferred();
}

function setRecordingControlsActive(active) {
  document.body.classList.toggle('recording-mode-active', active);
  updateRemyPositionDeferred();
}

function beginFlightGather() {
  state.lastFlightGatherPercent = -1;
  state.manualControl = Boolean(state.particleSystem && state.settings.particleEffectEnabled);
  updateFlightGatherProgress(0);
}

function updateFlightGatherProgress(time) {
  if (!state.particleSystem) return;
  if (state.lastFlightGatherPercent === 0 && time >= EXPORT_GATHER_DURATION) return;
  const progress = state.settings.particleEffectEnabled
    ? Math.max(0, 1 - time / EXPORT_GATHER_DURATION)
    : 0;
  state.particleSystem.setProgressImmediate(progress);
  const progressPercent = Math.round(progress * 100);
  if (progressPercent !== state.lastFlightGatherPercent) {
    state.lastFlightGatherPercent = progressPercent;
    dom.progressSlider.value = progressPercent;
    dom.progressValue.textContent = `${progressPercent}%`;
  }
  if (progress <= 0) state.manualControl = false;
}

function cancelGatherAnimation() {
  if (state.gatherAnimationId) {
    cancelAnimationFrame(state.gatherAnimationId);
    state.gatherAnimationId = null;
  }
  state.lastFlightGatherPercent = -1;
  state.manualControl = false;
}

function getCurrentFlightDuration() {
  return state.settings.presetFlight !== 'none'
    ? getPresetFlightDuration(state.settings.presetFlight)
    : Math.max(0, (state.keyframes.length - 1) * CUSTOM_KEYFRAME_SEGMENT_DURATION);
}

function applyCurrentFlightProgress(progress) {
  const clampedProgress = Math.max(0, Math.min(progress, 1));
  if (state.settings.presetFlight !== 'none') {
    applyPresetFlight(state.settings.presetFlight, clampedProgress);
  } else {
    interpolateCamera(clampedProgress);
  }
}

function updatePreviewStopButton() {
  if (!dom?.btnPreviewStop) return;
  dom.btnPreviewStop.textContent = t('btn-stop-preview');
}

function finishPreviewCycle() {
  if (!state.previewActive) return;
  const duration = getCurrentFlightDuration();
  state.previewTime = duration;
  applyRendererTimelineAtTime(
    state.previewTime,
    state.previewInitialRenderer,
    state.previewRendererTimeline
  );
  applyCurrentFlightProgress(duration > 0 ? state.previewTime / duration : 1);
  state.previewActive = false;
  state.previewCompleted = true;
  state.presetAnimation = null;
  cancelGatherAnimation();
  state.controls.enabled = false;
  setPreviewControlsActive(true);
  updatePreviewStopButton();
  dom.btnPreviewPath.textContent = t('btn-preview-path');
  showToast(t('flight-preview-finished'), 'success');
}

function stopPreviewFlight({ reopenPanel = true, keepTimeline = true } = {}) {
  state.previewActive = false;
  state.previewCompleted = false;
  setPreviewControlsActive(false);
  cancelGatherAnimation();
  state.controls.enabled = true;
  if (!keepTimeline) {
    state.previewInitialRenderer = null;
    state.previewRendererTimeline = [];
  }
  
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
  updatePreviewStopButton();
  if (reopenPanel) openCameraPathPanel();
}

function startPreviewFlight() {
  if (state.settings.presetFlight === 'none') {
    if (state.keyframes.length < 2 || !initCameraCurves()) return;
  }
  capturePreviewStart();
  state.previewInitialRenderer = state.settings.renderer;
  state.previewRendererTimeline = [];
  state.cancelScatterAnimation?.();
  cancelGatherAnimation();

  setRendererMode(state.previewInitialRenderer || state.settings.renderer, 'timeline');
  state.splatInterpolation = state.settings.renderer === 'spark' ? 1 : 0;
  state.splatInterpolationTarget = state.splatInterpolation;
  syncModelRendererVisibility();
  beginFlightGather();

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
      state.presetAnimation = null;
    }

    state.previewTime = 0.0;
    state.previewCompleted = false;
    state.settings.originalFov = state.camera.fov; // cache base FOV
    applyPresetFlight(state.settings.presetFlight, 0);
    const duration = getPresetFlightDuration(state.settings.presetFlight);
    state.presetProgressObj = { value: 0 };
    state.presetAnimation = gsap.to(state.presetProgressObj, {
      value: 1,
      duration,
      ease: 'none',
      repeat: 0,
      onUpdate: () => {
        if (!state.previewActive) return;
        state.previewTime = state.presetProgressObj.value * duration;
        applyPresetFlight(state.settings.presetFlight, state.presetProgressObj.value);
      },
      onComplete: () => {
        state.presetAnimation = null;
        if (state.previewActive) finishPreviewCycle();
      },
    });
    
    dom.btnPreviewPath.textContent = state.lang === 'zh' ? '停止' : 'Stop Preview';
    updatePreviewStopButton();
    showToast(`Looping preset: ${state.settings.presetFlight}`, 'info');
  } else {
    collapseCameraPathPanel();
    state.controls.enabled = false; // Disable user interaction during flight preview
    state.previewTime = 0.0;
    state.previewActive = true;
    state.previewCompleted = false;
    setPreviewControlsActive(true);
    dom.btnPreviewPath.textContent = state.lang === 'zh' ? '停止' : 'Stop Preview';
    updatePreviewStopButton();
    showToast('Previewing camera flight path...', 'info');
  }
}

function isMobileViewport() {
  return !IS_TABLET_DEVICE && window.matchMedia('(max-width: 600px), (pointer: coarse)').matches;
}

function updateRotationControls() {
  const label = state.rotationPaused
    ? t('btn-resume-rotation')
    : t('btn-stop-rotation');
  const title = label;

  [dom.btnToggleRotation, dom.btnMobileToggleRotation].forEach((button) => {
    if (!button) return;
    button.classList.toggle('active', button === dom.btnToggleRotation && state.rotationPaused);
    button.setAttribute('aria-pressed', String(state.rotationPaused));
    button.title = title;
    const text = button.querySelector('.btn-text');
    if (text) text.textContent = label;
  });
}

function toggleModelRotation() {
  if (!state.isModelLoaded) {
    showToast(t('load-model-first'), 'warning');
    return;
  }

  state.rotationPaused = !state.rotationPaused;
  if (state.particleSystem) {
    const cameraFlowLocksRotation = state.cameraModeActive
      || state.previewActive
      || state.previewCompleted
      || state.recordingActive
      || state.exportPreparing
      || state.compositingActive;
    state.particleSystem.autoRotate = !state.rotationPaused && !cameraFlowLocksRotation;
  }
  updateRotationControls();
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

const EXPORT_FPS = 60;
const EXPORT_VIDEO_BITRATE = 15_000_000;
const EXPORT_GATHER_DURATION = 2.5;
const COMPOSITION_POLL_INTERVAL_MS = 50;
const COMPOSITION_MODULE_TIMEOUT_MS = 12_000;
const COMPOSITION_START_TIMEOUT_MS = 15_000;
const COMPOSITION_FRAME_TIMEOUT_MS = 15_000;
const COMPOSITION_FINALIZE_TIMEOUT_MS = 30_000;
const COMPOSITION_CANCEL_TIMEOUT_MS = 600;

function supportsWebCodecsComposition() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

class ExportCancelledError extends Error {
  constructor() {
    super('Video composition cancelled');
    this.name = 'ExportCancelledError';
  }
}

function setCompositionControlsActive(active) {
  document.body.classList.toggle('compositing-mode-active', active);
  if (!dom.btnCancelComposition) return;
  dom.btnCancelComposition.disabled = false;
  dom.btnCancelComposition.textContent = t('btn-stop-composition');
}

function setPreviewExportBusy(busy) {
  if (!dom.btnPreviewExport) return;
  dom.btnPreviewExport.disabled = busy;
  if (busy) {
    dom.btnPreviewExport.setAttribute('aria-busy', 'true');
  } else {
    dom.btnPreviewExport.removeAttribute('aria-busy');
  }
}

function requestStopComposition() {
  if (!document.body.classList.contains('compositing-mode-active')) return;
  state.compositionCancelRequested = true;
  if (dom.btnCancelComposition) {
    dom.btnCancelComposition.disabled = true;
    dom.btnCancelComposition.textContent = t('stopping-composition');
  }
  updateLoadingProgress(0, t('stopping-composition'));
}

function throwIfCompositionCancelled() {
  if (state.compositionCancelRequested) throw new ExportCancelledError();
}

function waitForCompositionTask(task, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;
    let cancelPoll = null;
    let visibleStartedAt = 0;
    let remainingTimeoutMs = timeoutMs;

    const pauseTimeout = () => {
      if (timeout === null) return;
      clearTimeout(timeout);
      timeout = null;
      remainingTimeoutMs = Math.max(0, remainingTimeoutMs - (performance.now() - visibleStartedAt));
    };

    const resumeTimeout = () => {
      if (settled || document.hidden || timeout !== null) return;
      if (remainingTimeoutMs <= 0) {
        finish(reject, new Error(`${label} timed out after ${timeoutMs}ms of active page time`));
        return;
      }
      visibleStartedAt = performance.now();
      timeout = setTimeout(() => {
        timeout = null;
        remainingTimeoutMs = 0;
        finish(reject, new Error(`${label} timed out after ${timeoutMs}ms of active page time`));
      }, remainingTimeoutMs);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) pauseTimeout();
      else resumeTimeout();
    };

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      pauseTimeout();
      if (cancelPoll !== null) clearInterval(cancelPoll);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      callback(value);
    };

    cancelPoll = setInterval(() => {
      if (state.compositionCancelRequested) {
        finish(reject, new ExportCancelledError());
      }
    }, COMPOSITION_POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    resumeTimeout();

    Promise.resolve(task).then(
      value => finish(resolve, value),
      error => finish(reject, error)
    );
  });
}

async function cancelWebCodecsOutput(output) {
  if (!output || typeof output.cancel !== 'function') return;
  await Promise.race([
    Promise.resolve().then(() => output.cancel()).catch(() => {}),
    new Promise(resolve => setTimeout(resolve, COMPOSITION_CANCEL_TIMEOUT_MS)),
  ]);
}

function captureCameraState() {
  return {
    position: state.camera.position.clone(),
    target: state.controls.target.clone(),
    fov: state.camera.fov,
    near: state.camera.near,
    far: state.camera.far,
  };
}

function restoreCameraState(cameraState) {
  state.camera.position.copy(cameraState.position);
  state.controls.target.copy(cameraState.target);
  state.camera.fov = cameraState.fov;
  state.camera.near = cameraState.near;
  state.camera.far = cameraState.far;
  state.camera.updateProjectionMatrix();
  state.controls.update();
}

function setExactRendererState(mode) {
  setRendererMode(mode, 'composite');
  state.splatInterpolation = mode === 'spark' ? 1 : 0;
  state.splatInterpolationTarget = state.splatInterpolation;
  if (state.splatMesh) state.splatMesh.opacity = state.splatInterpolation;
  if (state.particleSystem) {
    state.particleSystem.setTransitionDirection(mode === 'spark' ? 1 : -1);
    state.particleSystem.setSplatInterpolation(state.splatInterpolation);
  }
  state.rendererVisibility = { particles: null, spark: null };
  syncModelRendererVisibility();
}

function configureExportCanvas(session) {
  state.renderer.setPixelRatio(1);
  state.renderer.setSize(session.exportWidth, session.exportHeight, false);
  const displayScale = Math.min(
    session.originalWidth / session.exportWidth,
    session.originalHeight / session.exportHeight
  );
  dom.container.style.setProperty('--export-canvas-width', `${Math.round(session.exportWidth * displayScale)}px`);
  dom.container.style.setProperty('--export-canvas-height', `${Math.round(session.exportHeight * displayScale)}px`);
  dom.container.classList.add('export-aspect-active');
  state.camera.aspect = session.exportWidth / session.exportHeight;
  state.camera.updateProjectionMatrix();

  if (state.particleSystem) {
    state.particleSystem.setViewportSize(session.exportWidth, session.exportHeight);
    const previewBufferWidth = session.originalWidth * session.pixelRatio;
    const previewBufferHeight = session.originalHeight * session.pixelRatio;
    const exportScale = Math.min(
      session.exportWidth / previewBufferWidth,
      session.exportHeight / previewBufferHeight
    );
    state.particleSystem.setPointSize(state.settings.pointSize * exportScale);
  }
}

function resetExportPlayback(session) {
  cancelGatherAnimation();
  setSparkPrewarmActive(false);
  state.recordTime = 0;
  state.virtualElapsedTime = 0;
  state.camera.position.copy(session.startCamera.position);
  state.controls.target.copy(session.startCamera.target);
  state.camera.fov = session.startCamera.fov;
  state.camera.near = session.startCamera.near;
  state.camera.far = session.startCamera.far;
  state.camera.updateProjectionMatrix();
  setExactRendererState(session.initialRenderer);
  const initialParticleProgress = state.settings.particleEffectEnabled ? 1 : 0;
  state.particleSystem?.setProgressImmediate(initialParticleProgress);
  applyCurrentFlightProgress(0);
  state.renderer.render(state.scene, state.camera);
}

function renderExportFrame(session, timelineTime, flightProgress) {
  setSparkPrewarmActive(shouldPrewarmSparkAtTime(
    timelineTime,
    session.initialRenderer,
    session.rendererTimeline,
    session.fps
  ));
  applyRendererTimelineAtTime(
    timelineTime,
    session.initialRenderer,
    session.rendererTimeline
  );
  applyCurrentFlightProgress(flightProgress);

  state.splatInterpolationTarget = state.settings.renderer === 'spark' ? 1 : 0;
  const transitionDirection = state.splatInterpolationTarget >= state.splatInterpolation ? 1 : -1;
  state.splatInterpolation += (state.splatInterpolationTarget - state.splatInterpolation) * 0.04;
  if (Math.abs(state.splatInterpolation - state.splatInterpolationTarget) < 0.001) {
    state.splatInterpolation = state.splatInterpolationTarget;
  }

  if (state.splatMesh) {
    state.splatMesh.opacity = transitionDirection > 0
      ? Math.pow(state.splatInterpolation, 2.1)
      : Math.pow(state.splatInterpolation, 1.45);
  }
  syncModelRendererVisibility();

  if (state.particleSystem) {
    state.particleSystem.autoRotate = false;
    const gatherProgress = state.settings.particleEffectEnabled
      ? Math.max(0, 1 - timelineTime / EXPORT_GATHER_DURATION)
      : 0;
    state.particleSystem.setProgressImmediate(gatherProgress);
    state.particleSystem.setTransitionDirection(transitionDirection);
    state.particleSystem.setSplatInterpolation(state.splatInterpolation);
    state.particleSystem.update(1 / session.fps, timelineTime);
    if (!state.compositingActive) {
      dom.progressSlider.value = Math.round(gatherProgress * 100);
      dom.progressValue.textContent = `${Math.round(gatherProgress * 100)}%`;
    }
  }

  if (state.splatPivot && state.particleSystem?.pivot) {
    state.splatPivot.rotation.y = state.particleSystem.pivot.rotation.y;
  }
  return Boolean(
    state.sparkPrewarmActive
    || (
      state.splatMesh?.visible
      && (state.splatMesh.opacity ?? 0) > RENDERER_VISIBILITY_EPSILON
    )
  );
}

function restoreAfterExport(session) {
  cancelGatherAnimation();
  setSparkPrewarmActive(false);
  state.recordingActive = false;
  state.exportPreparing = false;
  state.exportInitialRenderer = null;
  state.exportRendererTimeline = [];
  state.exportStream?.getTracks().forEach(track => track.stop());
  state.exportStream = null;
  state.mediaRecorder = null;
  state.activeWebCodecsOutput = null;
  state.compositionCancelRequested = false;
  setPreviewExportBusy(false);
  setCompositionControlsActive(false);
  setRecordingControlsActive(false);
  setExactRendererState(session.restoreRenderer);
  state.splatInterpolation = session.restoreInterpolation;
  state.splatInterpolationTarget = session.restoreInterpolationTarget;
  if (state.splatMesh) state.splatMesh.opacity = session.restoreSplatOpacity;
  if (state.particleSystem) {
    const restoreDirection = session.restoreInterpolationTarget >= session.restoreInterpolation ? 1 : -1;
    state.particleSystem.setTransitionDirection(restoreDirection);
    state.particleSystem.setSplatInterpolation(session.restoreInterpolation);
    state.particleSystem.setProgressImmediate(session.restoreParticleProgress);
  }
  state.settings.originalFov = session.restoreOriginalFov;
  state.settings.flightStartSpherical = session.restoreFlightStartSpherical;
  restoreRendererAfterExport(session.originalWidth, session.originalHeight, session.pixelRatio);
  restoreCameraState(session.restoreCamera);
  state.rendererVisibility = { particles: null, spark: null };
  syncModelRendererVisibility();
  updateRendererUI();
  hideLoading();
}

function restoreCompositionPreviewControls(session) {
  restoreAfterExport(session);
  state.previewStart = session.restorePreviewStart;
  state.previewInitialRenderer = session.initialRenderer;
  state.previewRendererTimeline = session.rendererTimeline.map(event => ({ ...event }));
  state.previewActive = false;
  state.previewCompleted = true;
  state.previewTime = session.returnToPreview ? session.restorePreviewTime : 0;
  state.controls.enabled = false;
  setPreviewControlsActive(true);
  updatePreviewStopButton();
}

function finishExportBlob(blob, filename, session, type = 'video/mp4') {
  restoreAfterExport(session);
  rememberCameraPathFirstFrame(session.cameraPathFirstFrame || session.startCamera);
  state.restoreCameraPathFirstFrameOnOpen = true;
  if (!blob?.size) {
    showToast(
      state.lang === 'zh'
        ? '浏览器没有生成视频数据，请尝试使用最新版 Safari 或 Chrome'
        : 'No video data was generated. Try the latest Safari or Chrome.',
      'error',
      7000
    );
    return;
  }
  deliverVideoBlob(blob, filename);
  showToast(
    type.includes('mp4')
      ? (state.lang === 'zh' ? 'MP4 已生成，请保存到手机' : 'MP4 ready to save')
      : (state.lang === 'zh' ? '当前浏览器仅支持 WebM，视频已生成' : 'This browser supports WebM export; video ready'),
    'success',
    6000
  );
}

async function compositeVideoWithWebCodecs(session) {
  throwIfCompositionCancelled();
  if (!supportsWebCodecsComposition()) {
    throw new Error('WebCodecs VideoEncoder / VideoFrame unavailable');
  }

  updateLoadingProgress(
    0.005,
    state.lang === 'zh' ? '正在加载视频合成模块…' : 'Loading video composition module…'
  );
  const mediabunny = await waitForCompositionTask(
    import('mediabunny'),
    COMPOSITION_MODULE_TIMEOUT_MS,
    'Video composition module loading'
  );
  const {
    Output,
    BufferTarget,
    Mp4OutputFormat,
    CanvasSource,
  } = mediabunny;
  throwIfCompositionCancelled();
  updateLoadingProgress(
    0.01,
    state.lang === 'zh' ? '正在初始化视频编码器…' : 'Initializing video encoder…'
  );
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat(),
    target,
  });
  state.activeWebCodecsOutput = output;
  const videoSource = new CanvasSource(state.renderer.domElement, {
    codec: 'avc',
    bitrate: session.bitrate,
  });
  output.addVideoTrack(videoSource);
  const totalFrames = Math.max(1, Math.round(session.duration * session.fps));
  try {
    await waitForCompositionTask(
      output.start(),
      COMPOSITION_START_TIMEOUT_MS,
      'Video encoder initialization'
    );
    throwIfCompositionCancelled();
    updateLoadingProgress(0.02, `${t('compositing-video')} · 0%`);
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      throwIfCompositionCancelled();
      // Keep two-second keyframe boundaries on exact exported frame numbers.
      // Reserve the final encoded frame for the exact last viewpoint instead
      // of stretching every intermediate timestamp across totalFrames - 1.
      const timelineTime = totalFrames === 1 || frameIndex === totalFrames - 1
        ? session.duration
        : Math.min(frameIndex / session.fps, session.duration);
      const flightProgress = session.duration > 0 ? timelineTime / session.duration : 1;
      const needsSparkSettlePass = renderExportFrame(session, timelineTime, flightProgress);
      if (needsSparkSettlePass) {
        // The first pass submits the new camera state to Spark's sorting worker.
        state.renderer.render(state.scene, state.camera);
      }
      // Give Spark's worker one paint opportunity to finish camera-dependent
      // sorting and let the progress UI update. This rAF is not the app's
      // animation loop and therefore cannot advance the export timeline.
      await waitForCompositionTask(
        new Promise(resolve => requestAnimationFrame(resolve)),
        COMPOSITION_FRAME_TIMEOUT_MS,
        'Export frame rendering'
      );
      throwIfCompositionCancelled();
      // Always render immediately before CanvasSource reads the drawing buffer.
      // Particle-only frames use this single pass; Spark frames use it as the
      // settled second pass after the worker has updated splat ordering.
      state.renderer.render(state.scene, state.camera);
      await waitForCompositionTask(
        videoSource.add(frameIndex / session.fps, 1 / session.fps),
        COMPOSITION_FRAME_TIMEOUT_MS,
        'Export frame encoding'
      );
      throwIfCompositionCancelled();

      const progress = (frameIndex + 1) / totalFrames;
      updateLoadingProgress(
        0.02 + progress * 0.94,
        `${t('compositing-video')} · ${Math.round(progress * 100)}%`
      );
    }
    updateLoadingProgress(0.98, t('finalizing-video'));
    throwIfCompositionCancelled();
    await waitForCompositionTask(
      output.finalize(),
      COMPOSITION_FINALIZE_TIMEOUT_MS,
      'MP4 finalization'
    );
    throwIfCompositionCancelled();
  } catch (error) {
    await cancelWebCodecsOutput(output);
    if (state.compositionCancelRequested || error?.name === 'ExportCancelledError') {
      throw new ExportCancelledError();
    }
    throw error;
  } finally {
    state.activeWebCodecsOutput = null;
  }

  if (!target.buffer) throw new Error('WebCodecs produced no MP4 data');
  updateLoadingProgress(1, t('done'));
  return new Blob([target.buffer], { type: 'video/mp4' });
}

function startMediaRecorderFallback(session) {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('This browser does not support MediaRecorder');
  }
  const canvas = state.renderer.domElement;
  if (typeof canvas.captureStream !== 'function') {
    throw new Error('Canvas video capture is not supported by this browser');
  }

  resetExportPlayback(session);
  const stream = canvas.captureStream(session.fps);
  state.exportStream = stream;
  const mimeType = selectRecordingMimeType();
  const recorderOptions = { videoBitsPerSecond: session.bitrate };
  if (mimeType) recorderOptions.mimeType = mimeType;
  const chunks = [];
  const recorder = new MediaRecorder(stream, recorderOptions);
  let recorderFailed = false;

  recorder.ondataavailable = event => {
    if (event.data?.size) chunks.push(event.data);
  };
  recorder.onerror = event => {
    recorderFailed = true;
    restoreAfterExport(session);
    showToast(
      `${state.lang === 'zh' ? '视频导出失败' : 'Video export failed'}: ${event.error?.message || 'Recorder error'}`,
      'error',
      6000
    );
  };
  recorder.onstop = () => {
    if (recorderFailed) return;
    const actualType = recorder.mimeType || mimeType || 'video/webm';
    const rawBlob = new Blob(chunks, { type: actualType });
    const extension = actualType.includes('mp4') ? 'mp4' : 'webm';
    const filename = `${state.lastLoadedName || 'splat'}_render.${extension}`;
    const actualDuration = Math.min(
      session.duration,
      Math.max(state.recordTime, 1 / session.fps)
    );
    if (actualType.includes('webm')) {
      fixWebmDuration(rawBlob, actualDuration * 1000, fixedBlob => {
        finishExportBlob(fixedBlob, filename, session, actualType);
      });
    } else {
      finishExportBlob(rawBlob, filename, session, actualType);
    }
  };

  state.mediaRecorder = recorder;
  state.exportInitialRenderer = session.initialRenderer;
  state.exportRendererTimeline = session.rendererTimeline;
  state.recordTime = 0;
  state.recordingFps = session.fps;
  state.lastRecordFrameTime = performance.now();
  state.lastRecordRenderDelta = 1 / session.fps;
  state.recordFrameAccumulator = 0;
  state.virtualElapsedTime = 0;
  state.recordingActive = true;
  state.exportPreparing = false;
  setCompositionControlsActive(false);
  setRecordingControlsActive(true);
  recorder.start(1000);
  beginFlightGather();
  hideLoading();
  showToast(
    state.lang === 'zh'
      ? '正在使用兼容模式实时录制 1080p 视频，请保持页面打开…'
      : 'Recording a 1080p video in compatibility mode. Keep this page open…',
    'info',
    6000
  );
}

async function exportPathVideo({ fromPreview = false } = {}) {
  if (state.settings.presetFlight === 'none') {
    if (state.keyframes.length < 2 || !initCameraCurves()) {
      showToast(state.lang === 'zh' ? '请至少添加两个有效关键帧' : 'Add at least two valid keyframes', 'warning', 3000);
      return;
    }
  }
  if (state.recordingActive || state.exportPreparing || state.compositingActive) {
    showToast(state.lang === 'zh' ? '视频导出正在启动，请稍候' : 'Video export is starting. Please wait.', 'info', 2500);
    return;
  }
  if (state.previewActive && !fromPreview) return;

  const restoreCamera = captureCameraState();
  const savedPreviewStart = fromPreview && state.previewStart
    ? cloneCameraPathFrame(state.previewStart)
    : captureCurrentCameraPathFrame();
  rememberCameraPathFirstFrame(savedPreviewStart);
  const restoreRenderer = state.settings.renderer;
  const restoreInterpolation = state.splatInterpolation;
  const restoreInterpolationTarget = state.splatInterpolationTarget;
  const restoreSplatOpacity = state.splatMesh?.opacity ?? restoreInterpolation;
  const restoreParticleProgress = state.particleSystem?.getProgress?.() ?? 0;
  const restoreOriginalFov = state.settings.originalFov;
  const restoreFlightStartSpherical = { ...state.settings.flightStartSpherical };
  const initialRenderer = fromPreview && state.previewInitialRenderer
    ? state.previewInitialRenderer
    : state.settings.renderer;
  const rendererTimeline = fromPreview
    ? state.previewRendererTimeline.map(event => ({ ...event }))
    : [];
  const restorePreviewTime = state.previewTime;

  state.cancelScatterAnimation?.();
  cancelGatherAnimation();
  if (fromPreview) {
    stopPreviewFlight({ reopenPanel: false, keepTimeline: true });
    restorePreviewCameraStart();
  }

  if (state.settings.presetFlight !== 'none') {
    state.settings.originalFov = state.camera.fov;
    const offset = new THREE.Vector3().copy(state.camera.position).sub(state.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    state.settings.flightStartSpherical = {
      radius: spherical.radius,
      phi: spherical.phi,
      theta: spherical.theta,
    };
  }

  const mobileExport = isMobileViewport();
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;
  const mobileAspect = originalWidth / originalHeight;
  const exportWidth = mobileExport
    ? (mobileAspect <= 1 ? 1080 : Math.round(1080 * mobileAspect / 2) * 2)
    : 1920;
  const exportHeight = mobileExport
    ? (mobileAspect <= 1 ? Math.round(1080 / mobileAspect / 2) * 2 : 1080)
    : 1080;
  const session = {
    mobileExport,
    exportWidth,
    exportHeight,
    fps: EXPORT_FPS,
    bitrate: EXPORT_VIDEO_BITRATE,
    duration: getCurrentFlightDuration(),
    originalWidth,
    originalHeight,
    pixelRatio: state.renderer.getPixelRatio(),
    startCamera: captureCameraState(),
    restoreCamera,
    restoreRenderer,
    restoreInterpolation,
    restoreInterpolationTarget,
    restoreSplatOpacity,
    restoreParticleProgress,
    restoreOriginalFov,
    restoreFlightStartSpherical,
    initialRenderer,
    rendererTimeline,
    returnToPreview: fromPreview,
    restorePreviewTime,
    restorePreviewStart: savedPreviewStart,
    cameraPathFirstFrame: cloneCameraPathFrame(savedPreviewStart),
  };
  const useWebCodecs = supportsWebCodecsComposition();

  state.controls.enabled = false;
  collapseCameraPathPanel();
  // Only expose the compositing UI after the preview state has been fully
  // converted into a clean export session. Preparation errors must never leave
  // a visible 0% overlay with no active encoder behind it.
  state.exportPreparing = true;
  setPreviewExportBusy(true);
  state.compositionCancelRequested = false;
  setCompositionControlsActive(useWebCodecs);
  showLoading(useWebCodecs ? t('compositing-video') : t('fallback-recording'));
  updateLoadingProgress(
    useWebCodecs ? 0.01 : 0,
    useWebCodecs ? `${t('compositing-video')} · 0%` : t('fallback-recording')
  );

  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    configureExportCanvas(session);
    resetExportPlayback(session);

    // Real-time recording is only a compatibility path for browsers that do
    // not expose WebCodecs at all. Once WebCodecs is selected, an encoder or
    // background-tab error must not silently start a wall-clock recording.
    if (!useWebCodecs) {
      setCompositionControlsActive(false);
      await new Promise(resolve => setTimeout(resolve, 120));
      startMediaRecorderFallback(session);
      return;
    }

    pauseRegularAnimationLoop();
    const blob = await compositeVideoWithWebCodecs(session);
    const filename = `${state.lastLoadedName || 'splat'}_render.mp4`;
    try {
      finishExportBlob(blob, filename, session, 'video/mp4');
    } finally {
      resumeRegularAnimationLoop();
    }
  } catch (exportError) {
    resumeRegularAnimationLoop();
    const cancelled = exportError?.name === 'ExportCancelledError' || state.compositionCancelRequested;
    restoreCompositionPreviewControls(session);
    if (cancelled) {
      showToast(state.lang === 'zh' ? '已停止视频合成' : 'Video composition stopped', 'info', 3000);
      return;
    }
    const errorPrefix = useWebCodecs
      ? t('composition-failed-no-fallback')
      : (state.lang === 'zh' ? '视频导出失败' : 'Video export failed');
    showToast(`${errorPrefix}: ${exportError.message}`, 'error', 7000);
    console.error(
      useWebCodecs
        ? 'WebCodecs composition failed without starting MediaRecorder:'
        : 'MediaRecorder compatibility export failed:',
      exportError
    );
  }
}
// ============================================================
// Event Handlers
// ============================================================
function setupEventListeners() {
  state.controls?.addEventListener('start', () => {
    if (state.selectedKeyframeIndex === null) return;
    state.selectedKeyframeIndex = null;
    updateSelectedKeyframeUI();
  });
  state.controls?.addEventListener('change', () => {
    if (state.splatEraser?.active) {
      updateSplatEraserBrushDimensions(state.splatEraser);
      syncSplatEraserBrushCursor();
    }
  });

  const renderCanvas = state.renderer?.domElement;
  renderCanvas?.addEventListener('pointerdown', beginSplatEraserStroke, { capture: true });
  renderCanvas?.addEventListener('pointerdown', beginSplatCropDrag, { capture: true });
  renderCanvas?.addEventListener('pointermove', updateSplatCropHandleHover);
  renderCanvas?.addEventListener('pointerleave', () => {
    hideSplatEraserBrushCursor();
    if (!state.splatCropDrag && !state.splatEraser?.active && renderCanvas) renderCanvas.style.cursor = '';
  });
  window.addEventListener('pointermove', moveSplatEraserStroke, { capture: true, passive: false });
  window.addEventListener('pointerup', endSplatEraserStroke, { capture: true, passive: false });
  window.addEventListener('pointercancel', endSplatEraserStroke, { capture: true, passive: false });
  window.addEventListener('pointermove', moveSplatCropDrag, { capture: true, passive: false });
  window.addEventListener('pointerup', endSplatCropDrag, { capture: true, passive: false });
  window.addEventListener('pointercancel', endSplatCropDrag, { capture: true, passive: false });

  // Load from URL
  dom.btnLoad.addEventListener('click', loadFromUrl);
  dom.urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadFromUrl();
  });
  // Load from Landing Input
  const loadFromLanding = () => {
    let url = dom.landingUrlInput.value.trim();
    if (!url) {
      // Default demo model
      url = 'https://www.remy3d.cn/model/72ca9c87bca54600bfd0fdd95fa96e38';
      dom.landingUrlInput.value = url;
      showToast(state.lang === 'zh' ? '加载示例图像……' : 'Loading demo model...', 'info', 3000);
    }
    dom.urlInput.value = url;
    loadFromUrl();
  };
  dom.landingBtnLoad?.addEventListener('click', () => loadFromLanding());
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
    const icon = dom.btnPlayScatter ? dom.btnPlayScatter.querySelector('.scatter-play-label') : null;
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
    if (file && /\.(?:ply|splat)$/i.test(file.name)) {
      loadFromFile(file);
    } else if (file) {
      showToast(t('drop-ply-only'), 'error');
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
    const settingsOpen = !dom.settingsPanel.classList.contains('hidden');
    document.body.classList.toggle('settings-panel-active', settingsOpen);
    if (settingsOpen && isMobileViewport()) setMobileSettingsLevel('root');
    if (settingsOpen && state.isModelLoaded) {
      state.rotationPaused = true;
      if (state.particleSystem) state.particleSystem.autoRotate = false;
      updateRotationControls();
    }
    syncSplatCropHelperVisibility();
    if (dom.settingsPanel.classList.contains('hidden') && state.splatEraser?.active) {
      setSplatEraserActive(false, { silent: true });
    }
    
    // Auto-hide camera path panel if settings are opened
    if (state.cameraModeActive) {
      toggleCameraMode();
    }
  });
  dom.btnToggleRotation?.addEventListener('click', toggleModelRotation);
  dom.btnMobileToggleRotation?.addEventListener('click', toggleModelRotation);
  dom.btnDesktopParticleSettings?.addEventListener('click', () => {
    setRendererMode('particles', 'settings');
    updateDesktopSettingsUI();
  });
  dom.btnDesktopSplatSettings?.addEventListener('click', () => {
    state.settings.splatCropEnabled = false;
    updateCropToggleUI(dom.btnSplatCropToggle, false, 'splat');
    updateSplatCropShapeUI();
    updateSplatCropFromSettings();
    setRendererMode('spark', 'settings');
    updateDesktopSettingsUI();
  });
  // Camera Path mode event listeners
  dom.btnCameraMode.addEventListener('click', toggleCameraMode);
  dom.btnAddKeyframe.addEventListener('click', addKeyframe);
  dom.btnClearKeyframes.addEventListener('click', clearKeyframes);
  dom.btnPreviewPath.addEventListener('click', () => {
    if (state.previewActive || state.previewCompleted) {
      stopPreviewFlight();
    } else {
      startPreviewFlight();
    }
  });
  dom.btnHeaderPreview.addEventListener('click', () => startPreviewFlight());
  dom.btnPreviewToggleRenderer.addEventListener('click', () => toggleRendererMode('preview'));
  dom.btnPreviewStop.addEventListener('click', () => {
    if (state.previewActive || state.previewCompleted) stopPreviewFlight();
  });
  dom.btnPreviewExport.addEventListener('click', () => exportPathVideo({ fromPreview: true }));
  dom.btnRecordingToggleRenderer.addEventListener('click', () => toggleRendererMode('recording'));
  dom.btnRecordingStop.addEventListener('click', stopExportRecording);
  dom.btnCancelComposition.addEventListener('click', requestStopComposition);
  dom.btnExportVideo.addEventListener('click', exportPathVideo);

  dom.btnMobileParticleSettings?.addEventListener('click', () => {
    setMobileSettingsMode('particles');
  });
  dom.btnMobileSplatSettings?.addEventListener('click', () => {
    setMobileSettingsMode('spark');
  });
  dom.btnMobileSplatCropPanel?.addEventListener('click', () => {
    setMobileSplatTool('crop');
  });
  dom.btnMobileSplatEraserPanel?.addEventListener('click', () => {
    setMobileSplatTool('eraser');
  });
  dom.btnMobileSettingsReset?.addEventListener('click', resetMobileSettingsParameter);
  dom.btnMobileSettingsConfirm?.addEventListener('click', confirmMobileSettings);

  document.querySelectorAll('.mobile-particle-setting-tag').forEach((tag) => {
    tag.addEventListener('click', () => {
      document.querySelectorAll('.mobile-particle-setting-tag').forEach(item => item.classList.remove('active'));
      document.querySelectorAll('.mobile-parameter').forEach(item => item.classList.remove('mobile-active'));
      tag.classList.add('active');
      document.getElementById(tag.dataset.settingTarget)?.classList.add('mobile-active');
      syncSplatCropHelperVisibility();
    });
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
      try {
        localStorage.setItem('splat-lang', state.lang);
      } catch (_) {
        // Language switching still works for this session when storage is unavailable.
      }
      applyTranslations(state.lang);
      updateKeyframeUI();
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
  
  const applyScatterEffectSelection = (value) => {
    state.cancelScatterAnimation?.();
    if (value === 'none') {
      state.settings.particleEffectEnabled = false;
      state.particleSystem?.setProgressImmediate(0);
      dom.progressSlider.value = 0;
      dom.progressValue.textContent = '0%';
      return;
    }
    state.settings.particleEffectEnabled = true;
    const effectIndex = parseFloat(value);
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
  };
  dom.cameraScatterEffect?.addEventListener('change', (e) => applyScatterEffectSelection(e.target.value));
  // Particle crop is a GPU uniform update, so slider movement previews live.
  if (dom.settingCropFactor) {
    const applyParticleCropFactor = (value) => {
      const factor = THREE.MathUtils.clamp(parseFloat(value), 0.5, 3.0);
      state.settings.cropFactor = factor;
      dom.settingCropFactorVal.textContent = `${factor.toFixed(2)}x`;
      state.particleSystem?.setCropFactor(factor);
    };
    dom.settingCropFactor.addEventListener('input', (e) => {
      applyParticleCropFactor(e.target.value);
    });
    dom.settingCropFactor.addEventListener('change', (e) => {
      const factor = THREE.MathUtils.clamp(parseFloat(e.target.value), 0.5, 3.0);
      applyParticleCropFactor(factor);
    });
  }

  dom.btnParticleCropToggle?.addEventListener('click', () => {
    state.settings.cropOutliers = !state.settings.cropOutliers;
    updateCropToggleUI(dom.btnParticleCropToggle, state.settings.cropOutliers, 'particle');
    state.particleSystem?.setCropEnabled(state.settings.cropOutliers);
  });

  dom.btnSplatCropToggle?.addEventListener('click', () => {
    state.settings.splatCropEnabled = !state.settings.splatCropEnabled;
    updateCropToggleUI(dom.btnSplatCropToggle, state.settings.splatCropEnabled, 'splat');
    if (state.settings.splatCropEnabled) {
      applySplatCropShape('ellipsoid');
    } else {
      updateSplatCropShapeUI();
      updateSplatCropFromSettings();
    }
  });

  for (const button of [dom.btnSplatCropShapeEllipsoid, dom.btnSplatCropShapeBox]) {
    button?.addEventListener('click', () => {
      if (!state.settings.splatCropEnabled) {
        state.settings.splatCropEnabled = true;
        updateCropToggleUI(dom.btnSplatCropToggle, true, 'splat');
      }
      applySplatCropShape(button.dataset.cropShape);
    });
  }
  dom.btnMobileSplatCropNone?.addEventListener('click', () => {
    state.settings.splatCropEnabled = false;
    updateCropToggleUI(dom.btnSplatCropToggle, false, 'splat');
    updateSplatCropShapeUI();
    updateSplatCropFromSettings();
  });
  dom.btnSplatEraser?.addEventListener('click', () => {
    setSplatEraserActive(!state.splatEraser?.active);
  });
  dom.btnSplatEraserPaint?.addEventListener('click', () => {
    if (isMobileViewport()) {
      if (!state.splatEraser?.active) setSplatEraserActive(true);
    } else {
      setSplatEraserActive(!state.splatEraser?.active);
    }
  });
  dom.btnSplatEraserConfirm?.addEventListener('click', confirmSplatEraserSelection);
  dom.btnSplatEraserUndo?.addEventListener('click', undoSplatEraser);
  dom.settingSplatEraserSize?.addEventListener('input', (event) => {
    setSplatEraserBrushPercent(event.target.value);
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.splatEraser?.active) {
      setSplatEraserActive(false);
    } else if (
      state.splatEraser?.active
      && !state.splatEraser.touchLayout
      && (event.code === 'BracketLeft' || event.code === 'BracketRight')
    ) {
      const target = event.target;
      const isTyping = target instanceof HTMLElement && (
        target.isContentEditable
        || target.matches('textarea, select, input:not([type="range"])')
      );
      if (!isTyping) {
        const step = parseFloat(dom.settingSplatEraserSize?.step) || 1;
        const current = parseFloat(dom.settingSplatEraserSize?.value)
          || state.splatEraser.brushScale * 100;
        setSplatEraserBrushPercent(
          current + (event.code === 'BracketLeft' ? -step : step)
        );
        event.preventDefault();
      }
    } else if (event.key === 'Alt' && state.splatEraser?.active && !state.splatEraser.touchLayout) {
      state.splatEraser.cursorNavigation = true;
      syncSplatEraserBrushCursor();
      if (!state.splatEraser.drawing && state.renderer?.domElement) {
        state.renderer.domElement.style.cursor = 'grab';
      }
    }
  });
  window.addEventListener('keyup', (event) => {
    if (event.key === 'Alt' && state.splatEraser?.active && !state.splatEraser.touchLayout && !state.splatEraser.drawing) {
      state.splatEraser.cursorNavigation = false;
      syncSplatEraserBrushCursor();
      if (state.renderer?.domElement) state.renderer.domElement.style.cursor = 'none';
    }
  });
  
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
  applyTabletDesktopLayout();
  cacheDom();
  syncResponsiveControlLayout();
  applyTranslations(state.lang);
  updateKeyframeUI();
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
    '%cParticle Model Viewer Ready',
    'color: #00f5d4; font-size: 14px; font-weight: bold;'
  );
}
// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
