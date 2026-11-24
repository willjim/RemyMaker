import { ParticleSystem } from './particleSystem.js?v=6.4';

// This layer samples the actual decoded Gaussians, so every source index refers
// to the same splat as Spark's committed RGBA edit buffer for every file format.
export class SceneParticleOverlay {
  constructor(mesh, scene) {
    this.mesh = mesh;
    this.scene = scene;
    this.system = null;
    this.signature = null;
    this.rgbaSource = null;
    this.disposed = false;
  }

  async prepare(settings, crop) {
    const signature = JSON.stringify([settings.maxParticles, crop]);
    if (this.system && this.signature === signature && this.rgbaSource === this.mesh.splatRgba) return;
    const mesh = this.mesh;
    const rgbaSource = mesh.splatRgba;
    // Read committed alpha once per edit revision, never the temporary pink
    // selection mask. A read failure must reach the playback error handler.
    const rgba = rgbaSource ? await rgbaSource.getArray() : null;
    if (this.disposed) return;
    if (rgbaSource !== mesh.splatRgba || (rgba && rgba.length < mesh.numSplats * 4)) {
      throw new Error('Committed splat colors changed or could not be read. Please retry.');
    }
    const maxParticles = Math.max(1, Math.floor(settings.maxParticles || 500000));
    const positions = [], colors = [], opacities = [], indices = [];
    let eligibleCount = 0;
    let random = 0x897d23a1;
    mesh.forEachSplat((index, center, _scale, _rotation, opacity, color) => {
      const alpha = rgba ? rgba[index * 4 + 3] / 255 : opacity;
      if (!Number.isFinite(alpha) || alpha < 1 / 255) return;
      if (![center.x, center.y, center.z].every(Number.isFinite)) return;
      if (crop?.enabled) {
        const x = (center.x - crop.center.x) / crop.radii.x;
        const y = (center.y - crop.center.y) / crop.radii.y;
        const z = (center.z - crop.center.z) / crop.radii.z;
        const inside = crop.shape === 'box'
          ? Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) <= 1
          : x * x + y * y + z * z <= 1;
        if (!inside) return;
      }
      // Sample the retained subject, even if it contains very few splats.
      // A seeded reservoir keeps memory bounded for large uncropped scenes.
      let slot = eligibleCount++;
      if (slot >= maxParticles) {
        random ^= random << 13;
        random ^= random >>> 17;
        random ^= random << 5;
        slot = Math.floor((random >>> 0) / 0x100000000 * eligibleCount);
        if (slot >= maxParticles) return;
      }
      const offset = slot * 3;
      positions[offset] = center.x;
      positions[offset + 1] = center.y;
      positions[offset + 2] = center.z;
      colors[offset] = rgba ? rgba[index * 4] / 255 : color.r;
      colors[offset + 1] = rgba ? rgba[index * 4 + 1] / 255 : color.g;
      colors[offset + 2] = rgba ? rgba[index * 4 + 2] / 255 : color.b;
      opacities[slot] = alpha;
      indices[slot] = index;
    });
    const next = new ParticleSystem();
    try {
      if (indices.length) {
        const info = next.createFromData({
          positions: new Float32Array(positions), colors: new Float32Array(colors),
          opacities: new Float32Array(opacities), sourceSplatIndices: new Uint32Array(indices),
          count: indices.length, particleCropEnabled: false,
        }, this.scene);
        // Undo ParticleSystem's normalization, then inherit the exact source
        // mesh transform, including vertical flip, crop offset and model zoom.
        next.points.rotation.set(0, 0, 0);
        next.points.scale.setScalar(1 / info.scale);
        next.points.position.copy(info.center);
        next.pivot.matrixAutoUpdate = false;
        next.autoRotate = false;
        next.setOverlayMode(true);
        next.setOverlayOpacity(0);
        next.setCropEnabled(false);
        next.pivot.visible = false;
      }
    } catch (error) {
      next.dispose();
      throw error;
    }
    this.system?.dispose();
    this.system = next;
    this.signature = signature;
    this.rgbaSource = rgbaSource;
  }

  update({ settings, effect, time, delta, camera, opacity, width, height, pointScale = 1, exporting = false }) {
    const system = this.system;
    if (!system?.pivot) return;
    const visible = opacity > 0 && effect.active;
    system.pivot.visible = visible;
    if (!visible) return;
    this.mesh.updateWorldMatrix(true, false);
    system.pivot.matrix.copy(this.mesh.matrixWorld);
    system.pivot.matrixWorldNeedsUpdate = true;
    system.setViewportSize(width, height);
    system.setPointSize(settings.pointSize * pointScale, settings.pointSize);
    system.setParticleBrightness(settings.particleBrightness);
    system.setParticleSoftness(settings.particleSoftness);
    system.setParticleOpacity(settings.particleOpacity);
    system.setDensity(settings.pointDensity);
    system.setScatterEffect(settings.scatterEffect);
    system.setExportColorCompensation(exporting);
    system.setOverlayOpacity(opacity);
    system.setProgressImmediate(effect.progress);
    system.update(delta, time, camera);
  }

  hide() { if (this.system?.pivot) this.system.pivot.visible = false; }
  dispose() {
    this.disposed = true;
    this.system?.dispose();
    this.system = null;
  }
}
