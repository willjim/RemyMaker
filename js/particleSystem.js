/**
 * Particle System
 * Creates a THREE.Points-based particle visualization from vertex data.
 * Uses custom ShaderMaterial for glowing soft dots with scatter/gather animation.
 */
import * as THREE from 'three';

// Preserve the original effect at its former 60% state, while stretching that
// useful motion range across the full logical UI/animation progress range.
const EFFECT_PROGRESS_SCALE = 0.60;
// Vertex Shader
const vertexShader = /* glsl */ `
  attribute vec3 aOriginalPosition;
  attribute vec3 aRandomDir;
  attribute float aRandomSpeed;
  attribute float aPhaseOffset;
  attribute vec3 aColor;
  uniform float uProgress;
  uniform float uTime;
  uniform float uPointSize;
  uniform float uSplatInterpolation;
  uniform float uTransitionDirection; // 1.0 = point cloud -> 3DGS, -1.0 = 3DGS -> point cloud
  uniform float uVectorField; // selected vector field index (0.0 to 14.0)
  uniform float uMinY; // model minimum Y coordinate for printer scan normalization
  uniform float uMaxY; // model maximum Y coordinate for printer scan normalization
  uniform float uParticleCropEnabled;
  uniform float uParticleCropFactor;
  uniform float uParticleCropRadius;
  uniform vec3 uParticleCropCenter;
  varying vec3 vColor;
  varying float vAlpha;

  // --- Simplex Noise Helper Functions (Stefan Gustavson) ---
  vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
  vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}

  float snoise(vec3 v){
    const vec2  C = vec2(1.0/6.0, 1.0/3.0) ;
    const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);

    vec3 i  = floor(v + dot(v, C.yyy) );
    vec3 x0 =   v - i + dot(i, C.xxx) ;

    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min( g.xyz, l.zxy );
    vec3 i2 = max( g.xyz, l.zxy );

    vec3 x1 = x0 - i1 + 1.0 * C.xxx;
    vec3 x2 = x0 - i2 + 2.0 * C.xxx;
    vec3 x3 = x0 - D.yyy;

    i = mod(i, 289.0 );
    vec4 p = permute( permute( permute(
               i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
             + i.y + vec4(0.0, i1.y, i2.y, 1.0 ))
             + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));

    float n_ = 1.0/7.0;
    vec3  ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z *ns.z);

    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_ );

    vec4 x = x_ *ns.x + ns.yyyy;
    vec4 y = y_ *ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4( x.xy, y.xy );
    vec4 b1 = vec4( x.zw, y.zw );

    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;

    vec3 p0 = vec3(a0.xy,h.x);
    vec3 p1 = vec3(a0.zw,h.y);
    vec3 p2 = vec3(a1.xy,h.z);
    vec3 p3 = vec3(a1.zw,h.w);

    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;

    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1),
                                  dot(p2,x2), dot(p3,x3) ) );
  }

  vec3 snoiseVec3(vec3 p) {
    float s  = snoise(p);
    float s1 = snoise(p + vec3(17.15, 33.21, 5.43));
    float s2 = snoise(p + vec3(117.15, 233.21, 45.43));
    return vec3(s, s1, s2);
  }

  // --- Curl Noise via Finite Differences ---
  vec3 curlNoise(vec3 p) {
    const float e = 0.01;
    vec3 dx = vec3(e, 0.0, 0.0);
    vec3 dy = vec3(0.0, e, 0.0);
    vec3 dz = vec3(0.0, 0.0, e);

    vec3 p_x0 = snoiseVec3(p - dx);
    vec3 p_x1 = snoiseVec3(p + dx);
    vec3 p_y0 = snoiseVec3(p - dy);
    vec3 p_y1 = snoiseVec3(p + dy);
    vec3 p_z0 = snoiseVec3(p - dz);
    vec3 p_z1 = snoiseVec3(p + dz);

    float x = (p_y1.z - p_y0.z) - (p_z1.y - p_z0.y);
    float y = (p_z1.x - p_z0.x) - (p_x1.z - p_x0.z);
    float z = (p_x1.y - p_x0.y) - (p_y1.x - p_y0.x);

    return normalize(vec3(x, y, z) / (2.0 * e));
  }

  void main() {
    if (
      uParticleCropEnabled > 0.5
      && uParticleCropRadius > 0.0
      && distance(aOriginalPosition, uParticleCropCenter) > uParticleCropRadius * uParticleCropFactor
    ) {
      vColor = vec3(0.0);
      vAlpha = 0.0;
      gl_PointSize = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    // --- 1. Compute Point Cloud Animated Position ---
    float phase = aPhaseOffset;

    int effectId = int(floor(uVectorField + 0.5));
    float prog = uProgress;
    if (effectId == 17) {
      prog = pow(uProgress, 2.0); // Smooth quadratic slowdown, no harsh jump
    }
    // Linear progress mapping for uniform transition speed
    float easedProgress = prog;
    vec3 scatterOffset = vec3(0.0);
    vec3 pos = aOriginalPosition;
    
    // --- 1. Base Floating Particle Cloud ---
    // Instead of squishing scattered particles into a single point, they float as a loose,
    // beautiful cloud of space dust. We define a base 3D float offset using curl noise and random jitter.
    vec3 floatOffset = aRandomDir * (0.55 + 0.18 * sin(uTime * 0.45 + phase)) + vec3(
      sin(uTime * 0.62 + phase * 1.17),
      cos(uTime * 0.51 + phase * 1.31),
      sin(uTime * 0.57 + phase * 0.83)
    ) * 0.12;
    
    // --- 2. Propagating Wavefront Sweep starting from specific corners/centers ---
    // We define a localized wavefront sweeping across the model. Inside it, particles are scattered (1.0).
    // Outside it, they are gathered (0.0). This ensures particles scatter starting from the starting point outwards.
    // 0% slider (uProgress = 0.0) -> fully complete model (localProgress = 0.0 for all particles).
    // 100% slider (uProgress = 1.0) -> fully scattered particles (localProgress = 1.0 for all particles).
    vec3 sweepCorner = vec3(0.0, 0.0, 0.0); // Default starting point: Model Center
    float d = length(pos); // Default distance: from center
    float D_max = 2.2; // Maximum distance for center-swept effects
    float transitionWidth = 0.25; // Compact transition boundary for linear progression
    
    // Customize sweep corners/centers for different effects
    if (effectId == 1) {
      // Southwest Corner
      sweepCorner = vec3(-1.5, -1.5, -1.5);
      d = distance(pos, sweepCorner);
      D_max = 4.8;
      transitionWidth = 0.3;
    } else if (effectId == 2) {
      // Northeast Corner (Top-Right-Front)
      sweepCorner = vec3(1.5, 1.5, 1.5);
      d = distance(pos, sweepCorner);
      D_max = 4.8;
      transitionWidth = 0.3;
    } else if (effectId == 3) {
      // Thanos snap: sweeps from snap center out
      sweepCorner = vec3(0.0, 0.0, 0.0);
      d = length(pos);
      D_max = 2.2;
      transitionWidth = 0.1;
    } else if (effectId == 4) {
      // Vertical Thread ribbons: sweeps from bottom to top
      sweepCorner = vec3(0.0, -1.5, 0.0);
      d = pos.y - sweepCorner.y;
      D_max = 3.0;
      transitionWidth = 0.25;
    } else if (effectId == 5) {
      // Center out: sweeps radially from inside out
      sweepCorner = vec3(0.0, 0.0, 0.0);
      d = length(pos);
      D_max = 2.2;
      transitionWidth = 0.2;
    } else if (effectId == 7) {
      // Southeast corner
      sweepCorner = vec3(1.5, -1.5, 1.5);
      d = distance(pos, sweepCorner);
      D_max = 4.8;
      transitionWidth = 0.3;
    } else if (effectId == 8) {
      // Waterfall: sweeps from top to bottom
      sweepCorner = vec3(0.0, 1.5, 0.0);
      d = sweepCorner.y - pos.y;
      D_max = 3.0;
      transitionWidth = 0.25;
    } else if (effectId == 10) {
      // Cylinder Discs: sweeps from central axis outwards
      sweepCorner = vec3(0.0, 0.0, 0.0);
      d = length(pos.xz);
      D_max = 1.8;
      transitionWidth = 0.2;
    } else if (effectId == 11) {
      // Double Helix: sweeps along Y-axis (bottom to top)
      sweepCorner = vec3(0.0, -1.5, 0.0);
      d = pos.y - sweepCorner.y;
      D_max = 3.0;
      transitionWidth = 0.25;
    } else if (effectId == 13) {
      // Northwest Corner
      sweepCorner = vec3(-1.5, 1.5, -1.5);
      d = distance(pos, sweepCorner);
      D_max = 4.8;
      transitionWidth = 0.3;
    } else if (effectId == 14) {
      // Back to Front: sweeps along Z-axis
      sweepCorner = vec3(0.0, 0.0, -1.5);
      d = pos.z - sweepCorner.z;
      D_max = 3.0;
      transitionWidth = 0.25;
    } else if (effectId == 15) {
      // Pipe Inflow: sweeps from top-left-back corner
      sweepCorner = vec3(-2.0, 2.0, -2.0);
      d = distance(pos, sweepCorner);
      D_max = 6.0;
      transitionWidth = 0.3;
    }

    // Distance from origin [0,0,0]
    float r = length(pos);
    // Logarithmic space scaling factor: particles far from origin dissipate extremely fast
    float speedMult = 1.0 + log(1.0 + r * 4.0) * 1.5;
    // Logarithmic-mapped progress
    float localEasedProgress = pow(prog, 1.0 / speedMult);
    float sweepRadius = localEasedProgress * (D_max + transitionWidth);
    
    // Local progress for this particle (1.0 = scattered/floating, 0.0 = gathered/assembled)
    float localProgress = clamp((sweepRadius - d) / transitionWidth, 0.0, 1.0);

    if (effectId == 3) {
      // Stable clustered randomness makes multiple areas of the subject dissolve
      // together. Core particles occupy 2–80% of the timeline; distant scene
      // particles are deliberately reserved for the final 80–100%.
      vec3 randomCell = floor(pos * 5.0);
      float clusterRandom = fract(sin(dot(randomCell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
      float particleRandom = phase / 6.2831853;
      float activationRandom = mix(clusterRandom, particleRandom, 0.32);
      float subjectOrder = 0.02 + activationRandom * 0.78;
      float sceneDistance = clamp((r - 1.05) / 1.45, 0.0, 1.0);
      float sceneOrder = 0.80 + mix(activationRandom, sceneDistance, 0.72) * 0.18;
      float activationOrder = r <= 1.05 ? subjectOrder : sceneOrder;
      localProgress = smoothstep(activationOrder - 0.025, activationOrder + 0.025, uProgress);
    }
    
    if (effectId == 16) {
      // Hologram 3D Printer layer-by-layer zigzag sweep
      // Normalize Y coordinate between 0.0 and 1.0 using uMinY and uMaxY uniforms
      float normalizedY = clamp((pos.y - uMinY) / (uMaxY - uMinY + 0.001), 0.0, 1.0);
      float numRows = 30.0;
      float rowIdx = floor(normalizedY * numRows);
      float xNorm = (pos.x + 1.2) / 2.4;
      float scanX = (mod(rowIdx, 2.0) < 0.5) ? xNorm : (1.0 - xNorm);
      float printOrder = clamp((rowIdx + scanX) / numRows, 0.0, 1.0);
      float bandWidth = 0.06;
      float sweepProgress = localEasedProgress * (1.0 + bandWidth);
      localProgress = clamp((sweepProgress - printOrder) / bandWidth, 0.0, 1.0);
    } else if (effectId == 17) {
      // Rain style: sweep from top to bottom
      float normalizedY = clamp((pos.y - uMinY) / (uMaxY - uMinY + 0.001), 0.0, 1.0);
      float printOrder = 1.0 - normalizedY;
      float bandWidth = 0.06;
      float sweepProgress = localEasedProgress * (1.0 + bandWidth);
      localProgress = clamp((sweepProgress - printOrder) / bandWidth, 0.0, 1.0);
    }
    
    // Apply center smoothing for Rain Style to make center particles disperse/gather slowly
    if (effectId == 17) {
      float centerFactor = exp(-r * r * 5.0); // 1.0 at origin, decays to 0.0 outwards
      localProgress = mix(localProgress, prog, centerFactor);

      // Guarantee a complete endpoint even when a model contains distant lower
      // outliers beyond the preset sweep bounds. Blend over the final portion so
      // remaining particles finish continuously rather than popping at 100%.
      float endpointCompletion = smoothstep(0.70, 1.0, uProgress);
      localProgress = mix(localProgress, 1.0, endpointCompletion);
    }

    float localEased = localProgress; // Linear transition mapping for constant speed
    
    // --- 3. Evaluate Morphing Paths ---
    if (effectId == 0) {
      // 0: Original Unmodified Explosion (原始无序粒子炸裂)
      // Disperses globally without a sweeping wavefront, matching the original raw chaotic look
      scatterOffset = aRandomDir * aRandomSpeed * prog * 1.5;
    } else if (effectId == 1) {
      // 1: Southwest Corner Swarm (中心向外西南角凝聚)
      // Scattered target is swept towards the Southwest back corner as a loose, flowing cloud
      vec3 swarmTarget = vec3(-3.0, -3.0, -3.0) + floatOffset * 0.6;
      scatterOffset = (swarmTarget - pos) * localEased;
    } else if (effectId == 2) {
      // 2: Northeast Corner Swarm (中心向外东北角凝聚)
      // Scattered target is swept towards the Northeast front corner as a loose, flowing cloud
      vec3 swarmTarget = vec3(1.5, 1.5, 1.5) + floatOffset * 0.6;
      scatterOffset = (swarmTarget - pos) * localEased;
    } else if (effectId == 3) {
      // 3: Thanos snap (中心向外风沙分化)
      // Disintegrates starting from the snap center, blowing outwards and swirling far off-screen
      vec3 outDir = normalize(pos + vec3(0.001));
      vec3 windTarget = pos + outDir * 8.0 + floatOffset * 2.0 + aRandomDir * 1.5;
      scatterOffset = (windTarget - pos) * localEased;
    } else if (effectId == 4) {
      // 4: Thread Ribbons Sweep (中心向外丝线分化)
      // Arranges scattered particles onto curly wavy vertical ribbons
      float theta = pos.y * 10.0 + aPhaseOffset * 6.28;
      vec3 threadPos = vec3(cos(theta) * 1.8, pos.y, sin(theta) * 1.8) + floatOffset * 0.3;
      scatterOffset = (threadPos - pos) * localEased;
    } else if (effectId == 5) {
      // 5: Radial Center Expansion (中心向外球面分化)
      // Pushes scattered particles outwards radially onto a spherical shell
      vec3 radialTarget = pos + normalize(pos + vec3(0.001)) * 2.0 + floatOffset * 0.5;
      scatterOffset = (radialTarget - pos) * localEased;
    } else if (effectId == 6) {
      // 6: Cyber Grid Voxelization (中心向外数码格化)
      // Aligns scattered particles onto a perfect digital grid
      vec3 gridPos = floor((pos + vec3(0.06)) / 0.12) * 0.12 + floatOffset * 0.15;
      scatterOffset = (gridPos - pos) * localEased;
    } else if (effectId == 7) {
      // 7: Fluid Curl Noise Swarm (中心向外流体涡旋)
      // Disperses along smooth turbulent curl noise fluid streams
      scatterOffset = curlNoise(pos * 1.8 + vec3(0.0, uTime * 0.1, 0.0)) * (localEased * 1.8) + aRandomDir * (localEased * 0.3);
    } else if (effectId == 8) {
      // 8: Vertical Waterfall Cascade (中心向外瀑布坠落)
      // Scattered target falls downwards like water droplets
      vec3 fallPos = pos + vec3(0.0, -2.5, 0.0) + floatOffset * 0.4;
      scatterOffset = (fallPos - pos) * localEased;
    } else if (effectId == 9) {
      // 9: Magnetic Field Dipole (中心向外双极磁轨)
      vec3 m = vec3(0.0, 1.0, 0.0);
      float rMag = length(pos) + 0.15;
      vec3 uPos = pos / rMag;
      vec3 magneticB = (3.0 * dot(m, uPos) * uPos - m) / (rMag * rMag * rMag);
      scatterOffset = magneticB * (localEased * 0.3) + floatOffset * (localEased * 0.3);
    } else if (effectId == 10) {
      // 10: Concentric Disc Sweep (中心向外圆盘切面)
      float rad = length(pos.xz);
      float angle = atan(pos.z, pos.x + 0.001);
      float discOffset = (sin(pos.y * 12.0) * 0.5 + 1.0) * localEased * 1.5;
      scatterOffset = vec3(cos(angle) * discOffset, 0.0, sin(angle) * discOffset) + floatOffset * 0.3 * localEased;
    } else if (effectId == 11) {
      // 11: Double Helix Sweep (中心向外双螺旋线)
      float angle = pos.y * 8.0 + localProgress * 12.0 + uTime * 2.0;
      vec3 helix = vec3(cos(angle) * 0.8, pos.y + localProgress * 2.5, sin(angle) * 0.8) + floatOffset * 0.3;
      scatterOffset = (helix - pos) * localEased;
    } else if (effectId == 12) {
      // 12: Hyperbolic Saddle Morph (中心向外双曲鞍面)
      vec3 saddlePos = vec3(pos.x * 1.5, -pos.y * 0.5, pos.z * 1.5) + floatOffset * 0.4;
      scatterOffset = (saddlePos - pos) * localEased;
    } else if (effectId == 13) {
      // 13: Fractal Julia Orbit (中心向外分形轨道)
      vec3 julia = vec3(
        sin(pos.y * 2.0 + pos.z),
        sin(pos.z * 2.0 - pos.x),
        sin(pos.x * 2.0 + pos.y)
      ) * 1.2 + floatOffset * 0.3;
      scatterOffset = (julia - pos) * localEased;
    } else if (effectId == 14) {
      // 14: Wind Snap Sweep (中心向外横风吹砂)
      vec3 windTarget = pos + vec3(sin(pos.y * 5.0 + uTime) * 0.5, 0.8, 3.5) + floatOffset * 1.2;
      scatterOffset = (windTarget - pos) * localEased;
    } else if (effectId == 15) {
      // 15: Bent Pipe Inflow (管道流线涌入扫拂)
      vec3 pipeEntrance = vec3(-2.0, 2.0, -2.0);
      vec3 p0 = pos;
      vec3 p2 = pipeEntrance + floatOffset * 0.15;
      vec3 p1 = vec3(pipeEntrance.x, p0.y, pipeEntrance.z); // Quadratic bezier control point
      vec3 flowPos = (1.0 - localEased) * (1.0 - localEased) * p0 + 2.0 * (1.0 - localEased) * localEased * p1 + localEased * localEased * p2;
      scatterOffset = flowPos - pos;
    } else if (effectId == 16) {
      // 16: Hologram 3D Printer (3D打印一行行扫描)
      vec3 printTarget = pos + vec3(0.0, 0.8, 0.0) + floatOffset;
      scatterOffset = (printTarget - pos) * localEased;
    } else if (effectId == 17) {
      // 17: Rain (下雨模式: 粒子从上至下一点点组成模型)
      float rainProgress = mod(uTime * 1.8 + phase * 8.0, 6.0);
      float rainY = pos.y + 6.0 - rainProgress;
      vec3 rainTarget = vec3(pos.x + sin(phase * 15.0) * 0.4, rainY, pos.z + cos(phase * 15.0) * 0.4);
      scatterOffset = (rainTarget - pos) * localEased;
    }
    
    // Tiny subtle per-particle jitter (keeps points alive without crawling/flowing on the surface)
    vec3 floatingOffset = vec3(
      sin(uTime * 1.5 + phase) * 0.001,
      cos(uTime * 1.2 + phase * 1.3) * 0.001,
      sin(uTime * 1.0 + phase * 0.7) * 0.001
    );
    
    vec3 pointCloudPos = aOriginalPosition + floatingOffset + scatterOffset;
    
    // --- 2. Interpolate Position (Spatial Outward Wave Propagation) ---
    float distFromCenter = length(aOriginalPosition);
    float maxRadius = 1.3;
    float normDist = clamp(distFromCenter / maxRadius, 0.0, 1.0);
    
    // The transition wave travels from center outward when entering 3DGS and from the
    // shell back inward when collapsing to point cloud.
    float waveThreshold = uSplatInterpolation * 1.35;
    float reverseThreshold = (1.0 - uSplatInterpolation) * 1.35;
    float waveWidth = 0.35;
    float localSplatInterp = clamp((waveThreshold - normDist) / waveWidth, 0.0, 1.0);
    float reverseCloudReveal = clamp((reverseThreshold - (1.0 - normDist)) / waveWidth, 0.0, 1.0);
    float outwardMode = step(0.0, uTransitionDirection);
    float spatialTransition = mix(1.0 - reverseCloudReveal, localSplatInterp, outwardMode);

    vec3 posInterp = mix(pointCloudPos, aOriginalPosition, spatialTransition);
    vec4 mvPosition = modelViewMatrix * vec4(posInterp, 1.0);
    gl_Position = projectionMatrix * mvPosition;
   
    // --- 3. Compute Standard Point Size (Point Cloud Mode) ---
    float sizeAttenuation = 15.0 / (-mvPosition.z);
    float standardSize = uPointSize * sizeAttenuation;
    standardSize = clamp(standardSize, 1.5, 80.0);
    standardSize *= (1.0 + easedProgress * 0.5);

    // Fade out particles when they are dissipated for effects 1, 3, 11, and 14
    float fadeOut = 1.0;
    if (effectId == 1 || effectId == 3 || effectId == 11 || effectId == 14) {
      fadeOut = clamp((1.0 - localProgress) * 1.5, 0.0, 1.0);
    }

    // Spark renders the real 3DGS layer; this point shader only fades the cloud out.
    gl_PointSize = standardSize * mix(1.0, 0.65, spatialTransition) * fadeOut;

    float forwardBand = 1.0 - clamp(abs(waveThreshold - normDist) / 0.16, 0.0, 1.0);
    forwardBand = forwardBand * forwardBand * (3.0 - 2.0 * forwardBand);
    float reverseBand = 1.0 - clamp(abs(reverseThreshold - (1.0 - normDist)) / 0.18, 0.0, 1.0);
    reverseBand = reverseBand * reverseBand * (3.0 - 2.0 * reverseBand);
    
    // --- 6. Varying Outputs ---
    vec3 shadedColor = aColor;
    if (spatialTransition < 0.1) {
      float luminance = dot(aColor, vec3(0.299, 0.587, 0.114));
      vec3 saturated = mix(vec3(luminance), aColor, 1.3);
      shadedColor = clamp(saturated, 0.0, 1.0);
    }

    // Inject glowing laser band for printer scanning effect
    if (effectId == 16) {
      float laserBand = 1.0 - abs(localProgress - 0.5) * 2.0;
      laserBand = clamp(laserBand, 0.0, 1.0);
      vec3 printerGlowColor = vec3(0.0, 1.0, 0.8); // Beautiful neon cyan/green laser
      shadedColor = mix(shadedColor, printerGlowColor * 1.5, laserBand * 0.95);
    } else if (effectId == 17) {
      // Rain style: soft neon blue rain glow
      float rainGlow = localProgress;
      vec3 rainColor = vec3(0.4, 0.8, 1.0);
      shadedColor = mix(shadedColor, rainColor * 1.5, rainGlow * 0.7);
      gl_PointSize *= (1.0 + rainGlow * 0.3);
    }
    vColor = shadedColor;
    
    float pointCloudAlpha = mix(1.0, 0.08, easedProgress);
    float forwardAlpha = pointCloudAlpha * pow(1.0 - localSplatInterp, 3.0) + forwardBand * 0.12;
    float reverseAlpha = pointCloudAlpha * pow(reverseCloudReveal, 1.8);
    reverseAlpha += reverseBand * 0.28 * (1.0 - uSplatInterpolation);
    vAlpha = mix(reverseAlpha, forwardAlpha, outwardMode) * fadeOut;
  }
`;
// Fragment Shader
const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uParticleBrightness;
  uniform float uPointSize;
  uniform float uParticleSoftness;
  uniform float uParticleOpacity;
 
  void main() {
    
    vec2 center = gl_PointCoord - vec2(0.5);
    float dist = length(center);
    
    // --- Point Cloud Mode: Soft Gaussian Radial-Fade Glow Dot ---
    // Normalized distance: 0.0 at center, 1.0 at edge of point quad
    float r = dist * 2.0; // r in [0, 1] within the point sprite
    // Gaussian-like soft falloff: bright center, smooth fade to transparent edge
    float sharpAlpha = smoothstep(1.0, 0.95, r);
    float softAlpha = max(0.0, 1.0 - r);
    softAlpha = softAlpha * softAlpha;
    float glowAlpha = mix(sharpAlpha, softAlpha, uParticleSoftness);

    float finalAlpha = glowAlpha;
    // Discard nearly invisible fragments for performance
    if (finalAlpha < 0.005) {
      discard;
    }
    // In point cloud mode, the color IS the glow — no additional lighting needed.
    // With AdditiveBlending, overlapping particles naturally accumulate brightness
    // in dense areas, creating the luminous artistic look.
    // We scale down individual particle brightness so that accumulation
    // in dense regions produces the desired bright glow (not overblown white).
    vec3 finalColor = vColor;
    // Gentle brightness: each particle contributes a fraction,
    // additive overlap in dense areas makes them glow bright.
    finalColor *= uParticleBrightness;
    float sizeComp = clamp(0.20 / uPointSize, 0.2, 2.5);
    finalColor *= sizeComp;
    gl_FragColor = vec4(finalColor, finalAlpha * vAlpha * uParticleOpacity);
  }
`;

function reorderFloat32Attribute(source, itemSize, order) {
  const result = new Float32Array(source.length);
  for (let dst = 0; dst < order.length; dst++) {
    const src = order[dst];
    const srcOffset = src * itemSize;
    const dstOffset = dst * itemSize;
    for (let k = 0; k < itemSize; k++) {
      result[dstOffset + k] = source[srcOffset + k];
    }
  }
  return result;
}

export class ParticleSystem {
  constructor() {
    this.points = null;
    this.material = null;
    this.geometry = null;
    this.currentProgress = 0;
    this.targetProgress = 0;
    this.autoRotate = true;
    this.rotationSpeed = 0.15;
    this.particleCount = 0;
    this.modelScale = 1.0;
    this.pivot = null; // group for rotation
    this.isGestureActive = false;
    this.density = 1.0;
  }
  /**
   * Create particle system from parsed PLY data.
   * @param {{ positions: Float32Array, colors: Float32Array, count: number }} data
   * @param {THREE.Scene} scene
   */
  createFromData(data, scene) {
    const { positions, colors, count } = data;
    this.particleCount = count;
    // Clean up existing
    this.dispose();
    // --- Center and scale the model ---
    const cropConfig = {
      enabled: Boolean(data.particleCropEnabled),
      factor: Number.isFinite(data.particleCropFactor) ? data.particleCropFactor : 2.5,
      radius: Number.isFinite(data.particleCropRadius) ? data.particleCropRadius : 0,
      center: data.particleCropCenter || { x: 0, y: 0, z: 0 },
    };
    const { centeredPositions, scale, center } = this.centerAndScale(positions, count, cropConfig);
    this.modelScale = scale;
    const scaledCropCenter = new THREE.Vector3(
      cropConfig.center.x * scale,
      cropConfig.center.y * scale,
      cropConfig.center.z * scale
    );
    const scaledCropRadius = cropConfig.radius * scale;
    
    // Compute Y bounding range of the centered particles
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      const y = centeredPositions[i * 3 + 1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    this.modelMinY = minY;
    this.modelMaxY = maxY;
    // --- Generate per-vertex attributes ---
    const randomDirs = new Float32Array(count * 3);
    const randomSpeeds = new Float32Array(count);
    const phaseOffsets = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // Random direction on unit sphere
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      randomDirs[i * 3] = Math.sin(phi) * Math.cos(theta);
      randomDirs[i * 3 + 1] = Math.sin(phi) * Math.sin(theta);
      randomDirs[i * 3 + 2] = Math.cos(phi);
      // Random speed variation
      randomSpeeds[i] = 0.5 + Math.random() * 1.5;
      // Random phase for floating animation
      phaseOffsets[i] = Math.random() * Math.PI * 2;
    }
    // --- Generate Point Cloud Simplification Importance Attribute (Morton Order + Low-discrepancy Weyl sequence) ---
    const importanceScores = new Float32Array(count);
    
    // Find min/max coordinates to normalize into the 3D grid
    let minX = Infinity, minY_norm = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY_norm = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = centeredPositions[i * 3];
      const y = centeredPositions[i * 3 + 1];
      const z = centeredPositions[i * 3 + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY_norm) minY_norm = y;
      if (y > maxY_norm) maxY_norm = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    
    const sizeX = (maxX - minX) || 1.0;
    const sizeY = (maxY_norm - minY_norm) || 1.0;
    const sizeZ = (maxZ - minZ) || 1.0;
    
    // Helper to interleave 10-bit integer coordinates into a 30-bit Morton Code
    function interleave3D(x, y, z) {
      x = (x | (x << 16)) & 0x030000FF;
      x = (x | (x <<  8)) & 0x0300F00F;
      x = (x | (x <<  4)) & 0x030C30C3;
      x = (x | (x <<  2)) & 0x09249249;

      y = (y | (y << 16)) & 0x030000FF;
      y = (y | (y <<  8)) & 0x0300F00F;
      y = (y | (y <<  4)) & 0x030C30C3;
      y = (y | (y <<  2)) & 0x09249249;

      z = (z | (z << 16)) & 0x030000FF;
      z = (z | (z <<  8)) & 0x0300F00F;
      z = (z | (z <<  4)) & 0x030C30C3;
      z = (z | (z <<  2)) & 0x09249249;

      return x | (y << 1) | (z << 2);
    }
    
    const pointIndices = new Uint32Array(count);
    const mortonCodes = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      pointIndices[i] = i;
      const ix = Math.floor(((centeredPositions[i * 3] - minX) / sizeX) * 1023);
      const iy = Math.floor(((centeredPositions[i * 3 + 1] - minY_norm) / sizeY) * 1023);
      const iz = Math.floor(((centeredPositions[i * 3 + 2] - minZ) / sizeZ) * 1023);
      mortonCodes[i] = interleave3D(ix, iy, iz);
    }
    
    // Sort point indices based on Morton codes
    const sortedIndices = new Uint32Array(pointIndices);
    sortedIndices.sort((a, b) => mortonCodes[a] - mortonCodes[b]);
    
    // Assign importance using a low-discrepancy golden ratio sequence along the Morton curve
    // This distributes importance evenly in space across all grid scales.
    const goldRatio = 0.618033988749895;
    for (let r = 0; r < count; r++) {
      const origIdx = sortedIndices[r];
      importanceScores[origIdx] = (r * goldRatio) % 1.0;
    }

    const renderOrder = new Uint32Array(pointIndices);
    renderOrder.sort((a, b) => importanceScores[a] - importanceScores[b]);
    const orderedPositions = reorderFloat32Attribute(centeredPositions, 3, renderOrder);
    const orderedColors = reorderFloat32Attribute(colors, 3, renderOrder);
    const orderedRandomDirs = reorderFloat32Attribute(randomDirs, 3, renderOrder);
    const orderedRandomSpeeds = reorderFloat32Attribute(randomSpeeds, 1, renderOrder);
    const orderedPhaseOffsets = reorderFloat32Attribute(phaseOffsets, 1, renderOrder);

    // --- Create geometry ---
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(orderedPositions, 3));
    this.geometry.setAttribute('aOriginalPosition', new THREE.BufferAttribute(orderedPositions, 3));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(orderedColors, 3));
    this.geometry.setAttribute('aRandomDir', new THREE.BufferAttribute(orderedRandomDirs, 3));
    this.geometry.setAttribute('aRandomSpeed', new THREE.BufferAttribute(orderedRandomSpeeds, 1));
    this.geometry.setAttribute('aPhaseOffset', new THREE.BufferAttribute(orderedPhaseOffsets, 1));
    this.updateDrawRange();
    // --- Create material ---
    // AdditiveBlending: particles accumulate brightness where they overlap
    // depthWrite: false: particles never clip each other, free layering
    // transparent: true: enable alpha channel for soft Gaussian falloff
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uProgress: { value: 0.0 },
        uTime: { value: 0.0 },
        uPointSize: { value: 0.5 },
        uParticleBrightness: { value: 0.7 },
        uParticleSoftness: { value: 0.7 },
        uParticleOpacity: { value: 1.0 },
        uSplatInterpolation: { value: 0.0 },
        uTransitionDirection: { value: 1.0 },
        uVectorField: { value: 0.0 },
        uMinY: { value: this.modelMinY },
        uMaxY: { value: this.modelMaxY },
        uParticleCropEnabled: { value: cropConfig.enabled ? 1.0 : 0.0 },
        uParticleCropFactor: { value: cropConfig.factor },
        uParticleCropRadius: { value: scaledCropRadius },
        uParticleCropCenter: { value: scaledCropCenter },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    // --- Create Points ---
    this.points = new THREE.Points(this.geometry, this.material);
    
    // Rotate model 180 degrees around X-axis (invert Y/Z coordinate system mismatch)
    this.points.rotation.x = Math.PI;
    // Wrap in pivot group for rotation
    this.pivot = new THREE.Group();
    this.pivot.add(this.points);
    scene.add(this.pivot);
    return {
      particleCount: count,
      scale,
      center,
    };
  }
  /**
   * Center the model at origin and scale to fit viewport.
   */
  centerAndScale(positions, count, cropConfig = null) {
    // 1. Calculate distances from origin (0, 0, 0) for a subset of points to estimate scale robustly
    const sampleSize = Math.min(5000, count);
    const distances = [];
    const step = Math.max(1, Math.floor(count / sampleSize));

    const cropCenter = cropConfig?.center || { x: 0, y: 0, z: 0 };
    const cropLimit = (cropConfig?.radius || 0) * (cropConfig?.factor || 1);
    const useCropForScale = Boolean(cropConfig?.enabled && cropLimit > 0);
    const collectDistances = (applyCrop) => {
      for (let i = 0; i < sampleSize; i++) {
        const idx = i * step;
        if (idx * 3 >= positions.length) continue;
        const x = positions[idx * 3];
        const y = positions[idx * 3 + 1];
        const z = positions[idx * 3 + 2];
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
        if (
          applyCrop
          && Math.hypot(x - cropCenter.x, y - cropCenter.y, z - cropCenter.z) > cropLimit
        ) {
          continue;
        }
        distances.push(Math.sqrt(x * x + y * y + z * z));
      }
    };
    collectDistances(useCropForScale);
    if (distances.length === 0 && useCropForScale) {
      collectDistances(false);
    }
    
    // Sort distances to find 90th percentile (robust core radius)
    distances.sort((a, b) => a - b);
    const p90Idx = Math.floor(distances.length * 0.90);
    const coreRadius = distances.length > 0 ? distances[p90Idx] : 1.0;
    
    // Scale target is radius = 1.0 (bounding size = 2.0)
    const scale = coreRadius > 0.001 ? 1.0 / coreRadius : 1.0;
    
    // Keep center at (0, 0, 0) to align rotation strictly with PLY model's default coordinate origin
    const center = { x: 0, y: 0, z: 0 };
    
    // Apply scaling (without translation, keeping default center)
    const centeredPositions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      centeredPositions[i * 3] = positions[i * 3] * scale;
      centeredPositions[i * 3 + 1] = positions[i * 3 + 1] * scale;
      centeredPositions[i * 3 + 2] = positions[i * 3 + 2] * scale;
    }
    
    return { centeredPositions, scale, center };
  }
  /**
   * Set the scatter/gather progress target (0 = gathered, 1 = scattered).
   */
  setTargetProgress(value) {
    this.targetProgress = Math.max(0, Math.min(1, value));
  }

  getShaderProgress(logicalProgress) {
    const progress = Math.max(0, Math.min(1, logicalProgress));
    const effectId = Math.round(this.material?.uniforms.uVectorField.value || 0);
    if (effectId === 3) {
      // Thanos assigns its subject/scene timing per particle in the shader, so it
      // needs the full logical 0–1 range without the shared 60% compression.
      return progress;
    }
    if (effectId === 17) {
      // Preserve the shared 60% pacing through the first 60% of the slider, then
      // use the remaining 40% to reach the true shader endpoint continuously.
      if (progress <= 0.60) return progress * EFFECT_PROGRESS_SCALE;
      return 0.36 + ((progress - 0.60) / 0.40) * 0.64;
    }
    return progress * EFFECT_PROGRESS_SCALE;
  }

  syncProgressUniform() {
    if (this.material) {
      this.material.uniforms.uProgress.value = this.getShaderProgress(this.currentProgress);
    }
  }
  /**
   * Set progress immediately without interpolation.
   */
  setProgressImmediate(value) {
    this.targetProgress = Math.max(0, Math.min(1, value));
    this.currentProgress = this.targetProgress;
    this.syncProgressUniform();
  }
  /**
   * Get current progress.
   */
  getProgress() {
    return this.currentProgress;
  }
  /**
   * Update particle system each frame.
   * @param {number} deltaTime - Time since last frame in seconds.
   * @param {number} elapsedTime - Total elapsed time in seconds.
   */
  update(deltaTime, elapsedTime) {
    if (!this.material || !this.pivot) return;
    // Smooth interpolation of progress
    const lerpFactor = this.currentProgress < this.targetProgress ? 0.04 : 0.03;
    this.currentProgress += (this.targetProgress - this.currentProgress) * lerpFactor;
    // Snap to target when very close
    if (Math.abs(this.currentProgress - this.targetProgress) < 0.001) {
      this.currentProgress = this.targetProgress;
    }
    // Update uniforms
    this.syncProgressUniform();
    this.material.uniforms.uTime.value = elapsedTime;
    // Auto rotation with slower speed during hand gesture controls
    if (this.autoRotate) {
      let speedFactor = 1.0;
      if (this.isGestureActive) {
        speedFactor = 0.3; // Slow down speed by 70% during hand gesture control
      }
      this.pivot.rotation.y += this.rotationSpeed * speedFactor * deltaTime;
    }
  }
  setPointSize(size) {
    if (this.material) {
      this.material.uniforms.uPointSize.value = size;
    }
  }
  /**
   * Set point cloud density simplification factor (0.0 to 1.0).
   */
  setDensity(density) {
    this.density = Math.max(0.01, Math.min(1.0, density));
    this.updateDrawRange();
  }
  setCropEnabled(enabled) {
    if (this.material?.uniforms.uParticleCropEnabled) {
      this.material.uniforms.uParticleCropEnabled.value = enabled ? 1.0 : 0.0;
    }
  }
  setCropFactor(factor) {
    if (this.material?.uniforms.uParticleCropFactor) {
      this.material.uniforms.uParticleCropFactor.value = Math.max(0.5, Math.min(3.0, factor));
    }
  }
  updateDrawRange() {
    if (!this.geometry) return;
    const visibleCount = Math.max(1, Math.ceil(this.particleCount * this.density));
    this.geometry.setDrawRange(0, visibleCount);
  }
  /**
   * Set particle brightness.
   */
  setParticleBrightness(brightness) {
    if (this.material && this.material.uniforms.uParticleBrightness) {
      this.material.uniforms.uParticleBrightness.value = brightness;
    }
  }
  /**
   * Set particle softness.
   */
  setParticleSoftness(softness) {
    if (this.material && this.material.uniforms.uParticleSoftness) {
      this.material.uniforms.uParticleSoftness.value = softness;
    }
  }
  /**
   * Set particle opacity.
   */
  setParticleOpacity(opacity) {
    if (this.material && this.material.uniforms.uParticleOpacity) {
      this.material.uniforms.uParticleOpacity.value = opacity;
    }
  }
  /**
   * Set splat scale multiplier (3DGS mode only).
   */
  setSplatScale(scale) {
    // Kept as a public no-op: app-level pivot/Spark mesh scaling owns this now.
  }
  /**
   * Set splat interpolation factor (0 = point cloud, 1 = 3DGS).
   */
  setSplatInterpolation(value) {
    if (this.material) {
      this.material.uniforms.uSplatInterpolation.value = Math.max(0, Math.min(1, value));
    }
  }
  setTransitionDirection(direction) {
    if (this.material) {
      this.material.uniforms.uTransitionDirection.value = direction >= 0 ? 1.0 : -1.0;
    }
  }
  /**
   * Set the selected non-linear scatter vector field effect index.
   */
  setScatterEffect(index) {
    if (this.material) {
      this.material.uniforms.uVectorField.value = parseFloat(index);
      this.syncProgressUniform();
    }
  }
  /**
   * Set viewport size (for focal length calculations in shader).
   */
  setViewportSize(width, height) {
    // Kept as a public no-op for app/export code paths. Spark owns 3DGS projection.
  }
  /**
   * Clean up resources.
   */
  dispose() {
    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
    if (this.pivot) {
      this.pivot.parent?.remove(this.pivot);
      this.pivot = null;
    }
    this.points = null;
  }
}
