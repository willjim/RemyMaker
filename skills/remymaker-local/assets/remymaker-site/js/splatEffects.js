/**
 * GPU-driven regional assembly and dispersal for Spark 2.1 SplatMesh instances.
 *
 * `update(assembledFraction)` expects 0 for scattered and 1 for fully assembled.
 * Sample it from 1 to 0 to play dispersal.
 * `updateAt(seconds)` is available when driving the effect from elapsed time;
 * it uses the duration and startTime supplied to begin().
 *
 * The modifier is installed at the end of Spark's worldModifiers pipeline,
 * which is after its SplatEdit/crop stage. Call reset() before installing a
 * separate world-space tool modifier (for example the eraser).
 */
const SAMPLE_LIMIT = 4096;

function setRegionQuantiles(axis, uniform) {
  if (axis.length < 2) {
    // No meaningful direction in the sample. The shader can use the other
    // axis or distribute a degenerate point over time using its splat index.
    const coordinate = axis[0] ?? 0;
    uniform.setScalar(coordinate);
    return;
  }
  axis.sort((a, b) => a - b);
  const select = (fraction) => axis[Math.round((axis.length - 1) * fraction)];
  uniform.set(select(0.015), select(1 / 3), select(2 / 3), select(0.985));
}

export function createSplatArrival(mesh, { THREE, dyno } = {}) {
  if (!mesh) throw new TypeError('createSplatArrival requires a SplatMesh.');
  if (!THREE?.Matrix4 || !THREE?.Vector3) {
    throw new TypeError('createSplatArrival requires the THREE namespace.');
  }
  if (!dyno?.Dyno || !dyno?.DynoFloat || !dyno?.DynoInt || !dyno?.DynoMat4 || !dyno?.DynoVec4 || !dyno?.Gsplat) {
    throw new TypeError('createSplatArrival requires Spark 2.1 dyno.');
  }

  const progressUniform = new dyno.DynoFloat({ key: 'arrivalProgress', value: 1 });
  const directionUniform = new dyno.DynoInt({ key: 'arrivalDirection', value: 0 });
  const objectToViewUniform = new dyno.DynoMat4({
    key: 'arrivalWorldToView',
    value: new THREE.Matrix4(),
  });
  const viewToObjectUniform = new dyno.DynoMat4({
    key: 'arrivalViewToWorld',
    value: new THREE.Matrix4(),
  });
  const startMeshToViewUniform = new dyno.DynoMat4({
    key: 'arrivalStartMeshToView',
    value: new THREE.Matrix4(),
  });
  const worldToMeshUniform = new dyno.DynoMat4({
    key: 'arrivalWorldToMesh',
    value: new THREE.Matrix4(),
  });
  const tanHalfFovUniform = new dyno.DynoFloat({ key: 'arrivalTanHalfFov', value: 1 });
  const aspectUniform = new dyno.DynoFloat({ key: 'arrivalAspect', value: 1 });
  const regionXUniform = new dyno.DynoVec4({ key: 'arrivalRegionX', value: new THREE.Vector4(-1, -1 / 3, 1 / 3, 1) });
  const regionYUniform = new dyno.DynoVec4({ key: 'arrivalRegionY', value: new THREE.Vector4(-1, -1 / 3, 1 / 3, 1) });
  const radiusScaleUniform = new dyno.DynoFloat({ key: 'arrivalRadiusScale', value: 1 });

  const modifier = new dyno.Dyno({
    inTypes: {
      gsplat: dyno.Gsplat,
      progress: 'float',
      direction: 'int',
      objectToView: 'mat4',
      viewToObject: 'mat4',
      startMeshToView: 'mat4',
      worldToMesh: 'mat4',
      tanHalfFov: 'float',
      aspect: 'float',
      regionX: 'vec4',
      regionY: 'vec4',
      radiusScale: 'float',
    },
    outTypes: { gsplat: dyno.Gsplat },
    inputs: {
      gsplat: undefined,
      progress: progressUniform,
      direction: directionUniform,
      objectToView: objectToViewUniform,
      viewToObject: viewToObjectUniform,
      startMeshToView: startMeshToViewUniform,
      worldToMesh: worldToMeshUniform,
      tanHalfFov: tanHalfFovUniform,
      aspect: aspectUniform,
      regionX: regionXUniform,
      regionY: regionYUniform,
      radiusScale: radiusScaleUniform,
    },
    statements: ({ inputs, outputs }) => [
      `${outputs.gsplat} = ${inputs.gsplat};`,
      `float arrivalT = clamp(${inputs.progress}, 0.0, 1.0);`,
      `if (arrivalT <= 0.0) {`,
      `  ${outputs.gsplat}.rgba.a = 0.0;`,
      `} else if (arrivalT < 1.0 && ${inputs.gsplat}.rgba.a > 0.0) {`,
      `float arrivalSeed = float(${inputs.gsplat}.index);`,
      `float arrivalR1 = fract(sin(arrivalSeed * 12.9898 + 78.233) * 43758.5453);`,
      `float arrivalR2 = fract(sin(arrivalSeed * 39.3467 + 11.135) * 24634.6345);`,
      `float arrivalR3 = fract(sin(arrivalSeed * 73.1569 + 47.853) * 56445.2341);`,
      `vec4 arrivalOriginalView = ${inputs.startMeshToView} * ${inputs.worldToMesh} * vec4(${inputs.gsplat}.center, 1.0);`,
      `float arrivalDepth = max(-arrivalOriginalView.z, 0.01);`,
      `vec2 arrivalScreen = arrivalOriginalView.xy / (arrivalDepth * ${inputs.tanHalfFov} * vec2(${inputs.aspect}, 1.0));`,
      `bool arrivalHorizontal = ${inputs.direction} == 1 || ${inputs.direction} == 2;`,
      `vec4 arrivalQuantiles = arrivalHorizontal ? ${inputs.regionX} : ${inputs.regionY};`,
      `float arrivalCoordinate = arrivalHorizontal ? arrivalScreen.x : arrivalScreen.y;`,
      `if (arrivalQuantiles.w - arrivalQuantiles.x < 0.0001) {`,
      `  arrivalQuantiles = arrivalHorizontal ? ${inputs.regionY} : ${inputs.regionX};`,
      `  arrivalCoordinate = arrivalHorizontal ? arrivalScreen.y : arrivalScreen.x;`,
      `}`,
      // Interpolate three spatial bands, each with a similar number of points.
      // This keeps a dense part of the capture from arriving all at once.
      `vec3 arrivalWidths = max(arrivalQuantiles.yzw - arrivalQuantiles.xyz, vec3(0.0001));`,
      `vec3 arrivalBand = clamp((vec3(arrivalCoordinate) - arrivalQuantiles.xyz) / arrivalWidths, 0.0, 1.0);`,
      `float arrivalRank = dot(arrivalBand, vec3(1.0 / 3.0));`,
      `if (${inputs.direction} == 2 || ${inputs.direction} == 3) arrivalRank = 1.0 - arrivalRank;`,
      `if (arrivalQuantiles.w - arrivalQuantiles.x < 0.0001) arrivalRank = arrivalR3;`,
      `arrivalRank = clamp(arrivalRank * 0.94 + arrivalR1 * 0.06, 0.0, 1.0);`,
      `float arrivalWindow = mix(0.13, 0.19, arrivalR2);`,
      `float arrivalDelay = arrivalRank * (1.0 - arrivalWindow);`,
      `float arrivalLocalT = clamp((arrivalT - arrivalDelay) / arrivalWindow, 0.0, 1.0);`,
      `if (arrivalLocalT <= 0.0) {`,
      `  ${outputs.gsplat}.rgba.a = 0.0;`,
      `} else if (arrivalLocalT < 1.0) {`,
      `vec4 arrivalViewCenter = ${inputs.objectToView} * vec4(${inputs.gsplat}.center, 1.0);`,
      `float arrivalRadius = 3.0 * ${inputs.radiusScale} * max(max(${inputs.gsplat}.scales.x, ${inputs.gsplat}.scales.y), ${inputs.gsplat}.scales.z);`,
      `float arrivalHalfH = arrivalDepth * ${inputs.tanHalfFov} + arrivalRadius;`,
      `float arrivalHalfW = arrivalHalfH * ${inputs.aspect};`,
      `float arrivalX = mix(-arrivalHalfW * 1.28 - arrivalRadius, arrivalHalfW * 1.28 + arrivalRadius, arrivalR1);`,
      `float arrivalY = mix(-arrivalHalfH * 1.28 - arrivalRadius, arrivalHalfH * 1.28 + arrivalRadius, arrivalR2);`,
      `int arrivalSide = int(floor(arrivalR3 * 4.0));`,
      `if (${inputs.direction} == 0) {`,
      `  if (arrivalSide == 0) arrivalX = -arrivalHalfW * 1.28 - arrivalRadius;`,
      `  else if (arrivalSide == 1) arrivalX = arrivalHalfW * 1.28 + arrivalRadius;`,
      `  else if (arrivalSide == 2) arrivalY = arrivalHalfH * 1.28 + arrivalRadius;`,
      `  else arrivalY = -arrivalHalfH * 1.28 - arrivalRadius;`,
      `} else if (${inputs.direction} == 1) arrivalX = -arrivalHalfW * 1.28 - arrivalRadius;`,
      `else if (${inputs.direction} == 2) arrivalX = arrivalHalfW * 1.28 + arrivalRadius;`,
      `else if (${inputs.direction} == 3) arrivalY = arrivalHalfH * 1.28 + arrivalRadius;`,
      `else arrivalY = -arrivalHalfH * 1.28 - arrivalRadius;`,
      `vec3 arrivalStartView = vec3(arrivalX, arrivalY, -arrivalDepth);`,
      `vec2 arrivalChord = arrivalViewCenter.xy - arrivalStartView.xy;`,
      `float arrivalChordLength = max(length(arrivalChord), 0.001);`,
      `vec2 arrivalPerp = vec2(-arrivalChord.y, arrivalChord.x) / arrivalChordLength;`,
      `float arrivalEase = smoothstep(0.0, 1.0, arrivalLocalT);`,
      `float arrivalCurve = (arrivalR2 * 2.0 - 1.0) * (arrivalHalfH * 0.18 + arrivalRadius);`,
      `vec2 arrivalControl = mix(arrivalStartView.xy, arrivalViewCenter.xy, 0.5) + arrivalPerp * arrivalCurve;`,
      `float arrivalRemain = 1.0 - arrivalEase;`,
      `vec2 arrivalPathXY = arrivalRemain * arrivalRemain * arrivalStartView.xy + 2.0 * arrivalRemain * arrivalEase * arrivalControl + arrivalEase * arrivalEase * arrivalViewCenter.xy;`,
      `float arrivalPathZ = mix(arrivalStartView.z, arrivalViewCenter.z, arrivalEase);`,
      `vec4 arrivalPathWorld = ${inputs.viewToObject} * vec4(arrivalPathXY, arrivalPathZ, 1.0);`,
      // Compact translucent splats stay visible in flight while the settled
      // geometry defines the silhouette.
      `float arrivalSettle = smoothstep(0.52, 1.0, arrivalLocalT);`,
      `  ${outputs.gsplat}.center = arrivalPathWorld.xyz;`,
      `  ${outputs.gsplat}.scales = ${inputs.gsplat}.scales * mix(0.35, 1.0, arrivalSettle);`,
      `  ${outputs.gsplat}.rgba.a *= smoothstep(0.02, 0.42, arrivalLocalT) * mix(0.25, 1.0, arrivalSettle);`,
      `}`,
      `}`,
    ],
  });

  const directionCodes = { all: 0, left: 1, right: 2, top: 3, bottom: 4 };
  let started = false;
  let suspended = false;
  let disposed = false;
  let durationSeconds = 1;
  let startTimeSeconds = 0;
  let startScale = 1;
  let sampledSource;
  let sampledCount = -1;
  let sampleCenters = [];
  let preparedRgbaSource = null;
  let preparedRgba = null;

  async function prepare() {
    const rgbaSource = mesh.splatRgba;
    if (disposed || !rgbaSource?.getArray || rgbaSource === preparedRgbaSource) return;
    try {
      const rgba = await rgbaSource.getArray();
      if (disposed || mesh.splatRgba !== rgbaSource) return;
      preparedRgbaSource = rgbaSource;
      preparedRgba = rgba;
    } catch (error) {
      // A readback failure only affects timing calibration. The modifier still
      // runs after the committed GPU mask and cannot reveal erased splats.
      if (!disposed && mesh.splatRgba === rgbaSource) {
        console.warn('3DGS assembly could not sample the erased scene.', error);
      }
    }
  }

  function getSampleCenters() {
    const source = mesh.splats || mesh.extSplats || mesh.packedSplats;
    const count = source?.numSplats ?? mesh.numSplats;
    if (sampledSource === source && sampledCount === count) return sampleCenters;
    sampledSource = source;
    sampledCount = count;
    sampleCenters = [];
    const stride = Math.max(1, Math.ceil(count / SAMPLE_LIMIT));
    const add = (index, center, opacity) => {
      if (opacity <= 0 || !Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(center.z)) return;
      sampleCenters.push({ index, center: center.clone() });
    };
    if (source?.getSplat) {
      for (let index = Math.floor(stride / 2); index < count; index += stride) {
        const { center, opacity } = source.getSplat(index);
        add(index, center, opacity);
      }
    } else {
      mesh.forEachSplat?.((index, center, _scales, _rotation, opacity) => {
        if (index % stride === 0) add(index, center, opacity);
      });
    }
    return sampleCenters;
  }

  function configureRegion(bounds, near) {
    const allX = [];
    const allY = [];
    const visibleX = [];
    const visibleY = [];
    const view = new THREE.Vector3();
    const collect = (center) => {
      view.copy(center).applyMatrix4(startMeshToViewUniform.value);
      const depth = -view.z;
      if (depth <= near) return;
      const y = view.y / (depth * tanHalfFovUniform.value);
      const x = view.x / (depth * tanHalfFovUniform.value * aspectUniform.value);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      allX.push(x);
      allY.push(y);
      if (Math.abs(x) <= 1 && Math.abs(y) <= 1) {
        visibleX.push(x);
        visibleY.push(y);
      }
    };
    const rgba = mesh.splatRgba === preparedRgbaSource ? preparedRgba : null;
    for (const { index, center } of getSampleCenters()) {
      if (rgba?.[index * 4 + 3] === 0) continue;
      if (!bounds || bounds.containsPoint(center)) collect(center);
    }
    if (!allX.length && bounds) {
      // A tiny crop can be smaller than the sample stride. Use its corners
      // to set the ordering range without decoding all splats on each seek.
      const { min, max } = bounds;
      for (const x of [min.x, max.x]) {
        for (const y of [min.y, max.y]) {
          for (const z of [min.z, max.z]) collect(new THREE.Vector3(x, y, z));
        }
      }
    }
    // Visible samples define the growth direction in room-sized scans, where
    // out-of-frame splats should not determine how quickly the subject appears.
    const useVisible = visibleX.length >= 8;
    setRegionQuantiles(useVisible ? visibleX : allX, regionXUniform.value);
    setRegionQuantiles(useVisible ? visibleY : allY, regionYUniform.value);
  }

  function getWorldModifiers() {
    if (Array.isArray(mesh.worldModifiers)) return mesh.worldModifiers.slice();
    return mesh.worldModifier ? [mesh.worldModifier] : [];
  }

  function setWorldModifiers(modifiers) {
    mesh.worldModifiers = modifiers.length ? modifiers.slice() : undefined;
    mesh.updateGenerator?.();
  }

  function removeArrivalFromCurrentPipeline() {
    const current = getWorldModifiers();
    const filtered = current.filter((entry) => entry !== modifier);
    if (filtered.length !== current.length) setWorldModifiers(filtered);
  }

  function update(progress) {
    if (disposed) return;
    if (started && !suspended) {
      mesh.updateWorldMatrix?.(true, false);
      worldToMeshUniform.value.copy(mesh.matrixWorld).invert();
      radiusScaleUniform.value = startScale / Math.max(1e-6, mesh.matrixWorld.getMaxScaleOnAxis());
    }
    const value = Number(progress);
    const next = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    if (next !== progressUniform.value) {
      progressUniform.value = next;
      mesh.updateVersion?.();
    }
  }

  function begin({ camera, direction = 'all', duration = 1, startTime = 0, bounds = null } = {}) {
    if (disposed) throw new Error('Cannot begin a disposed splat arrival effect.');
    if (!camera) throw new TypeError('begin() requires the active camera.');
    if (!Object.hasOwn(directionCodes, direction)) {
      throw new RangeError(`Unsupported arrival direction: ${String(direction)}`);
    }

    camera.updateMatrixWorld?.(true);
    mesh.updateWorldMatrix?.(true, false);
    // World modifiers run after the mesh transform, so gsplat.center is in
    // world space here. Freeze camera matrices so starts don't follow it.
    objectToViewUniform.value = camera.matrixWorldInverse.clone();
    viewToObjectUniform.value = camera.matrixWorld.clone();
    startMeshToViewUniform.value.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
    worldToMeshUniform.value.copy(mesh.matrixWorld).invert();
    startScale = Math.max(1e-6, mesh.matrixWorld.getMaxScaleOnAxis());
    radiusScaleUniform.value = 1;

    const effectiveFov = typeof camera.getEffectiveFOV === 'function'
      ? camera.getEffectiveFOV()
      : camera.fov / (camera.zoom || 1);
    tanHalfFovUniform.value = Math.max(1e-6, Math.tan(THREE.MathUtils.degToRad(effectiveFov) * 0.5));
    aspectUniform.value = Math.max(Number(camera.aspect) || 1, 0.001);
    directionUniform.value = directionCodes[direction];
    durationSeconds = Math.max(Number(duration) || 0, 1e-6);
    startTimeSeconds = Number(startTime) || 0;
    configureRegion(bounds, Math.max(0.01, Number(camera.near) || 0.01));

    const current = getWorldModifiers();
    if (!current.includes(modifier)) setWorldModifiers([...current, modifier]);
    started = true;
    suspended = false;
    progressUniform.value = 0;
    mesh.updateVersion?.();
  }

  function updateAt(seconds) {
    const now = Number(seconds);
    update((now - startTimeSeconds) / durationSeconds);
  }

  function reset() {
    if (disposed || !started) return;
    // Other tools may have changed their own modifiers in the meantime.
    // Remove only this effect and retain their latest state.
    removeArrivalFromCurrentPipeline();
    progressUniform.value = 1;
    started = false;
    suspended = false;
  }

  function suspend() {
    if (disposed || !started || suspended) return;
    removeArrivalFromCurrentPipeline();
    suspended = true;
  }

  function resume() {
    if (disposed || !started || !suspended) return;
    const current = getWorldModifiers().filter((entry) => entry !== modifier);
    setWorldModifiers([...current, modifier]);
    suspended = false;
  }

  function dispose() {
    if (disposed) return;
    reset();
    sampleCenters = [];
    preparedRgba = null;
    preparedRgbaSource = null;
    disposed = true;
  }

  return { prepare, begin, update, updateAt, reset, suspend, resume, dispose };
}
