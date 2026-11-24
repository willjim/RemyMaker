/**
 * GPU-driven arrival animation for Spark 2.1 SplatMesh instances.
 *
 * Progress API: `update(progress)` expects a normalized value in [0, 1].
 * `updateAt(seconds)` is available when driving the effect from elapsed time;
 * it uses the duration and startTime supplied to begin().
 *
 * The modifier is installed at the end of Spark's worldModifiers pipeline,
 * which is after its SplatEdit/crop stage. Call reset() before installing a
 * separate world-space tool modifier (for example the eraser), or use
 * suspend()/resume() to temporarily remove/re-append this effect.
 */
export function createSplatArrival(mesh, { THREE, dyno } = {}) {
  if (!mesh) throw new TypeError('createSplatArrival requires a SplatMesh.');
  if (!THREE?.Matrix4 || !THREE?.Vector3) {
    throw new TypeError('createSplatArrival requires the THREE namespace.');
  }
  if (!dyno?.Dyno || !dyno?.DynoFloat || !dyno?.DynoInt || !dyno?.DynoMat4 || !dyno?.Gsplat) {
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
    },
    statements: ({ inputs, outputs }) => [
      `${outputs.gsplat} = ${inputs.gsplat};`,
      `float arrivalT = clamp(${inputs.progress}, 0.0, 1.0);`,
      `float arrivalSeed = float(${inputs.gsplat}.index);`,
      `float arrivalR1 = fract(sin(arrivalSeed * 12.9898 + 78.233) * 43758.5453);`,
      `float arrivalR2 = fract(sin(arrivalSeed * 39.3467 + 11.135) * 24634.6345);`,
      `float arrivalR3 = fract(sin(arrivalSeed * 73.1569 + 47.853) * 56445.2341);`,
      `vec4 arrivalViewCenter = ${inputs.objectToView} * vec4(${inputs.gsplat}.center, 1.0);`,
      `vec4 arrivalOriginalView = ${inputs.startMeshToView} * ${inputs.worldToMesh} * vec4(${inputs.gsplat}.center, 1.0);`,
      `float arrivalDepth = max(-arrivalOriginalView.z, 0.01);`,
      `float arrivalRadius = 3.0 * max(max(${inputs.gsplat}.scales.x, ${inputs.gsplat}.scales.y), ${inputs.gsplat}.scales.z);`,
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
      `float arrivalDelay = arrivalR1 * 0.18;`,
      `float arrivalLocalT = clamp((arrivalT - arrivalDelay) / (1.0 - arrivalDelay), 0.0, 1.0);`,
      `float arrivalEase = 1.0 - pow(1.0 - arrivalLocalT, 3.0);`,
      `float arrivalCurve = (arrivalR2 * 2.0 - 1.0) * (arrivalHalfH * 0.18 + arrivalRadius);`,
      `vec2 arrivalControl = mix(arrivalStartView.xy, arrivalViewCenter.xy, 0.5) + arrivalPerp * arrivalCurve;`,
      `float arrivalRemain = 1.0 - arrivalEase;`,
      `vec2 arrivalPathXY = arrivalRemain * arrivalRemain * arrivalStartView.xy + 2.0 * arrivalRemain * arrivalEase * arrivalControl + arrivalEase * arrivalEase * arrivalViewCenter.xy;`,
      `float arrivalPathZ = mix(arrivalStartView.z, arrivalViewCenter.z, arrivalEase);`,
      `vec4 arrivalPathWorld = ${inputs.viewToObject} * vec4(arrivalPathXY, arrivalPathZ, 1.0);`,
      `if (arrivalT >= 1.0) {`,
      `  ${outputs.gsplat}.center = ${inputs.gsplat}.center;`,
      `  ${outputs.gsplat}.scales = ${inputs.gsplat}.scales;`,
      `  ${outputs.gsplat}.rgba.a = ${inputs.gsplat}.rgba.a;`,
      `} else {`,
      `  ${outputs.gsplat}.center = arrivalPathWorld.xyz;`,
      `  ${outputs.gsplat}.scales = ${inputs.gsplat}.scales * mix(0.06, 1.0, arrivalEase);`,
      `  ${outputs.gsplat}.rgba.a = ${inputs.gsplat}.rgba.a * arrivalEase;`,
      `}`,
    ],
  });

  const directionCodes = { all: 0, left: 1, right: 2, top: 3, bottom: 4 };
  let savedWorldModifiers = null;
  let started = false;
  let suspended = false;
  let disposed = false;
  let durationSeconds = 1;
  let startTimeSeconds = 0;

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
    }
    const value = Number(progress);
    const next = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    if (next !== progressUniform.value) {
      progressUniform.value = next;
      mesh.updateVersion?.();
    }
  }

  function begin({ camera, direction = 'all', duration = 1, startTime = 0 } = {}) {
    if (disposed) throw new Error('Cannot begin a disposed splat arrival effect.');
    if (!camera) throw new TypeError('begin() requires the active camera.');
    if (!(direction in directionCodes)) {
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

    const effectiveFov = typeof camera.getEffectiveFOV === 'function'
      ? camera.getEffectiveFOV()
      : camera.fov / (camera.zoom || 1);
    tanHalfFovUniform.value = Math.tan(THREE.MathUtils.degToRad(effectiveFov) * 0.5);
    aspectUniform.value = Math.max(Number(camera.aspect) || 1, 0.001);
    directionUniform.value = directionCodes[direction];
    durationSeconds = Math.max(Number(duration) || 0, 1e-6);
    startTimeSeconds = Number(startTime) || 0;
    update(0);

    savedWorldModifiers = getWorldModifiers();
    setWorldModifiers([...savedWorldModifiers.filter((entry) => entry !== modifier), modifier]);
    started = true;
    suspended = false;
  }

  function updateAt(seconds) {
    const now = Number(seconds);
    update((now - startTimeSeconds) / durationSeconds);
  }

  function reset() {
    if (disposed) return;
    update(1);
    if (started) {
      // Restore exactly the world modifier chain that existed at begin().
      setWorldModifiers(savedWorldModifiers || []);
    } else {
      removeArrivalFromCurrentPipeline();
    }
    savedWorldModifiers = null;
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
    disposed = true;
  }

  return { begin, update, updateAt, reset, suspend, resume, dispose };
}
