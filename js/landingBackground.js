import * as THREE from 'three';

export class LandingBackground {
  constructor(scene) {
    this.scene = scene;
    this.visible = true;
    
    // 22,000 particles to form a rich, dense, starry spiral galaxy
    this.particleCount = 22000;
    
    this.geometry = new THREE.BufferGeometry();
    
    const positions = new Float32Array(this.particleCount * 3);
    const colors = new Float32Array(this.particleCount * 3);
    
    this.generateGalaxy(positions, colors);
    
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    
    // Custom star canvas texture for soft, organic circular glowing points
    const texture = this.createStarTexture();
    
    this.material = new THREE.PointsMaterial({
      size: 0.015,
      map: texture,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.52 // Increased opacity by another 30% for high visibility
    });
    
    this.points = new THREE.Points(this.geometry, this.material);
    
    // Tilt the galaxy disk in 3D space to match the uploaded Andromeda photo perspective
    this.points.rotation.x = 0.85;
    this.points.rotation.y = 0.08;
    this.points.rotation.z = -0.58;
    
    this.scene.add(this.points);
  }
  
  createStarTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    
    const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.2, 'rgba(230, 245, 255, 0.8)');
    grad.addColorStop(0.5, 'rgba(110, 150, 255, 0.25)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 32);
    
    return new THREE.CanvasTexture(canvas);
  }
  
  generateGalaxy(positions, colors) {
    // 0% in bulge (core removed), 85% in disk (highly spread arms), 15% background stars
    const coreCount = 0;
    const armCount = Math.floor(this.particleCount * 0.85);
    const backgroundCount = this.particleCount - armCount;
    
    // 2. Galactic Disk (highly spread spiral arms that cover the entire disk area)
    for (let i = 0; i < armCount; i++) {
      const armIdx = i % 2; // Two main arms
      const r = 0.08 + Math.pow(Math.random(), 1.2) * 1.42; // Width increased
      
      // Logarithmic spiral angle + winding + wider random jitter to fill the gaps completely
      const theta = 2.2 * r + armIdx * Math.PI + (Math.random() - 0.5) * 3.5;
      
      const x = r * Math.cos(theta);
      const y = r * Math.sin(theta);
      // Vertical thickness tapers off at edges
      const z = (Math.random() - 0.5) * 0.08 * (1.50 - r);
      
      const idx = i * 3;
      positions[idx] = x;
      positions[idx + 1] = y;
      positions[idx + 2] = z;
      
      // Color gradient: warm pink near center, transitioning to bright neon blue and deep purple in the outer arms
      const color = new THREE.Color();
      const armPosRatio = (r - 0.08) / 1.42;
      
      if (armPosRatio < 0.35) {
        // Inner arm: pink/magenta
        color.lerpColors(new THREE.Color(0xff88aa), new THREE.Color(0xa855f7), armPosRatio / 0.35);
      } else {
        // Outer arm: blue/cyan
        color.lerpColors(new THREE.Color(0xa855f7), new THREE.Color(0x00d2ff), (armPosRatio - 0.35) / 0.65);
      }
      
      // Dim the colors (0.36 to 0.62 intensity) to make them look rich but preserve contrast
      const dim = 0.36 + Math.random() * 0.26;
      colors[idx] = color.r * dim;
      colors[idx + 1] = color.g * dim;
      colors[idx + 2] = color.b * dim;
    }
    
    // 3. Background dust & far field stars
    for (let i = 0; i < backgroundCount; i++) {
      const x = (Math.random() - 0.5) * 3.4;
      const y = (Math.random() - 0.5) * 3.4;
      const z = (Math.random() - 0.5) * 1.6;
      
      const idx = (coreCount + armCount + i) * 3;
      positions[idx] = x;
      positions[idx + 1] = y;
      positions[idx + 2] = z;
      
      // Muted stars (white/grey/dark blue) - dimmed
      const dim = 0.06 + Math.random() * 0.20;
      colors[idx] = dim;
      colors[idx + 1] = dim * 1.05;
      colors[idx + 2] = dim * 1.2;
    }
  }
  
  update(time) {
    if (!this.visible) return;
    
    // Slow, majestic rotation of the galaxy
    this.points.rotation.z = -0.58 + time * 0.006;
    
    // Tiny organic twinkling effect on star sizes
    const pulse = 1.0 + 0.04 * Math.sin(time * 2.5);
    this.material.size = 0.015 * pulse;
  }
}
