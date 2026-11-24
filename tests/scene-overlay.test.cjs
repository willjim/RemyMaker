const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const modulePath = path.join(__dirname, '..', 'js', 'sceneParticleOverlay.js');
const moduleSource = fs.readFileSync(modulePath, 'utf8')
  .replace(/^import .*;\s*$/gm, '')
  .replace('export class SceneParticleOverlay', 'class SceneParticleOverlay');

function makeHarness(splats, rgba = rgbaFor(splats)) {
  const captures = [];
  const systems = [];
  class ParticleSystemStub {
    constructor() {
      this.disposed = false;
      this.autoRotate = true;
      this.points = {
        rotation: { set() {} },
        scale: { setScalar() {} },
        position: { copy() {} },
      };
      this.pivot = { matrixAutoUpdate: true, visible: true };
      systems.push(this);
    }
    createFromData(data) {
      captures.push(data);
      return { scale: 2, center: { x: 0, y: 0, z: 0 } };
    }
    setOverlayMode() {}
    setOverlayOpacity() {}
    setCropEnabled() {}
    dispose() { this.disposed = true; }
  }

  const mesh = {
    numSplats: splats.length,
    splatRgba: rgba,
    visits: 0,
    forEachSplat(callback) {
      this.visits++;
      for (const splat of this.splats) {
        callback(splat.index, splat.center, splat.scale, splat.rotation, splat.opacity, splat.color);
      }
    },
    splats,
  };
  const context = vm.createContext({ ParticleSystem: ParticleSystemStub });
  vm.runInContext(`${moduleSource}\nglobalThis.SceneParticleOverlay = SceneParticleOverlay;`, context, {
    filename: 'js/sceneParticleOverlay.js',
  });
  const scene = {};
  return {
    overlay: new context.SceneParticleOverlay(mesh, scene),
    mesh,
    captures,
    systems,
  };
}

function rgbaFor(splats, alphaByIndex = {}) {
  const bytes = new Uint8Array(splats.length * 4);
  for (const splat of splats) {
    const offset = splat.index * 4;
    bytes[offset] = 40 + splat.index;
    bytes[offset + 1] = 80 + splat.index;
    bytes[offset + 2] = 120 + splat.index;
    bytes[offset + 3] = alphaByIndex[splat.index] ?? 255;
  }
  return { getArray: async () => bytes };
}

function splat(index, x, y, z = 0) {
  return {
    index,
    center: { x, y, z },
    scale: { x: 1, y: 1, z: 1 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    opacity: 1,
    color: { r: 1, g: 1, b: 1 },
  };
}

test('prepare applies ellipsoid crop, skips committed transparent splats, and preserves source indices', async () => {
  const splats = [splat(0, 0, 0), splat(1, 0.8, 0.8), splat(2, 1, 0), splat(3, 0.25, 0)];
  const { overlay, captures } = makeHarness(splats, rgbaFor(splats, { 3: 0 }));
  await overlay.prepare({ maxParticles: 100 }, {
    enabled: true,
    shape: 'ellipsoid',
    center: { x: 0, y: 0, z: 0 },
    radii: { x: 1, y: 1, z: 1 },
  });

  assert.equal(captures.length, 1);
  assert.deepEqual(Array.from(captures[0].sourceSplatIndices), [0, 2]);
  assert.equal(captures[0].count, 2);
  assert.ok(Math.abs(captures[0].opacities[1] - 1) < 1e-6);
});

test('prepare applies box crop bounds independently on each axis', async () => {
  const splats = [splat(0, 0.9, 0.9), splat(1, 1.01, 0), splat(2, 0, -1), splat(3, 0, 0, 1.1)];
  const { overlay, captures } = makeHarness(splats);
  await overlay.prepare({ maxParticles: 100 }, {
    enabled: true,
    shape: 'box',
    center: { x: 0, y: 0, z: 0 },
    radii: { x: 1, y: 1, z: 1 },
  });

  assert.deepEqual(Array.from(captures[0].sourceSplatIndices), [0, 2]);
});

test('crop filters before sampling so a sparse retained subject is still represented', async () => {
  const splats = [splat(0, 10, 0), splat(1, 0, 0), splat(2, 10, 0), splat(3, 10, 0)];
  const { overlay, captures } = makeHarness(splats);
  await overlay.prepare({ maxParticles: 1 }, {
    enabled: true,
    shape: 'box',
    center: { x: 0, y: 0, z: 0 },
    radii: { x: 1, y: 1, z: 1 },
  });
  assert.deepEqual(Array.from(captures[0].sourceSplatIndices), [1]);
});

test('disposing the model during RGBA readback prevents a stale overlay from attaching', async () => {
  let finishReadback;
  const rgba = { getArray: () => new Promise(resolve => { finishReadback = resolve; }) };
  const { overlay, captures } = makeHarness([splat(0, 0, 0)], rgba);
  const preparation = overlay.prepare({ maxParticles: 1 }, { enabled: false });
  overlay.dispose();
  finishReadback(new Uint8Array([40, 80, 120, 255]));
  await preparation;
  assert.equal(captures.length, 0);
  assert.equal(overlay.system, null);
});

test('same crop/settings reuse the sample; a new RGBA object rebuilds after undo', async () => {
  const splats = [splat(0, 0, 0), splat(1, 0.25, 0)];
  const { overlay, mesh, captures, systems } = makeHarness(splats);
  const crop = {
    enabled: true,
    shape: 'ellipsoid',
    center: { x: 0, y: 0, z: 0 },
    radii: { x: 1, y: 1, z: 1 },
  };
  const settings = { maxParticles: 100 };
  await overlay.prepare(settings, crop);
  const firstVisits = mesh.visits;
  assert.equal(captures.length, 1);

  // A moved source point would be outside the crop if sampled again. The
  // unchanged sample signature should reuse the existing geometry instead.
  mesh.splats[1] = splat(1, 10, 0);
  await overlay.prepare(settings, crop);
  assert.equal(mesh.visits, firstVisits);
  assert.equal(captures.length, 1);

  const previousSystem = systems[0];
  mesh.splatRgba = rgbaFor(mesh.splats, { 1: 0 }); // undo swaps the committed RGBA reference
  await overlay.prepare(settings, crop);
  assert.equal(captures.length, 2);
  assert.equal(previousSystem.disposed, true);
  assert.deepEqual(Array.from(captures[1].sourceSplatIndices), [0]);
});
