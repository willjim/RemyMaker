/**
 * Gesture Control Module
 * Uses MediaPipe Gesture Recognizer to detect hand gestures
 * for controlling particle scatter/gather animation.
 */
// MediaPipe Tasks Vision CDN
const MEDIAPIPE_VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
export class GestureControl {
  constructor() {
    this.gestureRecognizer = null;
    this.videoElement = null;
    this.stream = null;
    this.isInitialized = false;
    this.isRunning = false;
    this.lastVideoTime = -1;
    // Gesture state
    this.currentGesture = 'none';
    this.targetProgress = 0;        // 0 = gathered (fist), 1 = scattered (palm)
    this.gestureConfidence = 0;
    this.gestureHistory = [];        // For smoothing
    this.historyLength = 8;          // Increased for better smoothing
    this.candidateGesture = 'none';
    this.consecutiveFrames = 0;
    this.consecutivenessThreshold = 8; // Stable frames required to transition (~250ms at 30 FPS)
    // Rotation tracking
    this.inRotationMode = false;
    this.lastHandPos = null;
    // Callbacks
    this.onGestureChange = null;
    this.onStatusChange = null;
    this.onRotationChange = null;   // triggers when index+middle are extended for rotation (dx, dy)
  }
  /**
   * Initialize MediaPipe Gesture Recognizer and webcam.
   * @param {HTMLVideoElement} videoElement
   * @returns {Promise<void>}
   */
  async init(videoElement) {
    this.videoElement = videoElement;
    try {
      if (this.onStatusChange) this.onStatusChange('loading', 'Loading hand tracking model...');
      // Dynamic import of MediaPipe Tasks Vision
      const vision = await import(`${MEDIAPIPE_VISION_URL}/vision_bundle.mjs`);
      const { GestureRecognizer, FilesetResolver } = vision;
      // Initialize fileset
      const filesetResolver = await FilesetResolver.forVisionTasks(
        `${MEDIAPIPE_VISION_URL}/wasm`
      );
      // Create gesture recognizer
      this.gestureRecognizer = await GestureRecognizer.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath: MODEL_URL,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      if (this.onStatusChange) this.onStatusChange('ready', 'Starting camera...');
      // Get webcam stream
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 320 },
          height: { ideal: 240 },
          frameRate: { ideal: 15, max: 30 },
          facingMode: 'user',
        },
        audio: false,
      });
      this.videoElement.srcObject = this.stream;
      await this.videoElement.play();
      this.isInitialized = true;
      this.isRunning = true;
      if (this.onStatusChange) this.onStatusChange('active', 'Hand tracking active');
      return true;
    } catch (error) {
      console.error('Gesture control init failed:', error);
      const msg = error.name === 'NotAllowedError'
        ? 'Camera access denied'
        : error.name === 'NotFoundError'
          ? 'No camera found'
          : `Init failed: ${error.message}`;
      if (this.onStatusChange) this.onStatusChange('error', msg);
      return false;
    }
  }
  /**
   * Process a single video frame for gesture detection.
   * Should be called in the animation loop.
   * @param {number} timestamp - Current timestamp (from requestAnimationFrame)
   */
  detect(timestamp) {
    if (!this.isInitialized || !this.isRunning || !this.gestureRecognizer) return;
    if (!this.videoElement || this.videoElement.readyState < 2) return;
    // Avoid processing the same frame twice
    const currentTime = this.videoElement.currentTime;
    if (currentTime === this.lastVideoTime) return;
    this.lastVideoTime = currentTime;
    try {
      const result = this.gestureRecognizer.recognizeForVideo(this.videoElement, timestamp);
      this.processResult(result);
    } catch (e) {
      // Silently skip frame on error
    }
  }
  /**
   * Process gesture recognition result.
   */
  /**
   * Process gesture recognition result.
   */
  processResult(result) {
    let rawGesture = 'none';
    let confidence = 0;
    let landmarks = null;
    if (result.gestures && result.gestures.length > 0) {
      const topGesture = result.gestures[0][0];
      rawGesture = topGesture.categoryName;
      confidence = topGesture.score;
    }
    
    // Enforce high confidence threshold to prevent head/face or noise misdetections
    const MIN_CONFIDENCE = 0.62;
    if (confidence < MIN_CONFIDENCE) {
      rawGesture = 'none';
      landmarks = null;
    } else if (result.landmarks && result.landmarks.length > 0) {
      const tempLandmarks = result.landmarks[0];
      // Filter out passive hand placements (resting chin on hand, hand on face, etc.)
      if (tempLandmarks && this.isHandUpright(tempLandmarks)) {
        landmarks = tempLandmarks;
      } else {
        rawGesture = 'none';
        landmarks = null;
      }
    }
    
    // Add to history for smoothing
    this.gestureHistory.push(rawGesture);
    if (this.gestureHistory.length > this.historyLength) {
      this.gestureHistory.shift();
    }
    // Use majority voting for stability
    let smoothedGesture = this.getMajorityGesture();
    // Check custom two-finger rotation gesture
    if (landmarks && (smoothedGesture === 'Victory' || this.isTwoFingersExtended(landmarks))) {
      smoothedGesture = 'Victory';
    }
    // Check custom Pointing_Up gesture
    if (landmarks && (smoothedGesture === 'Pointing_Up' || this.isPointingUpGesture(landmarks))) {
      smoothedGesture = 'Pointing_Up';
    }
    // Check two-hand closed-fist zoom gesture
    let isZoomActiveRaw = false;
    let indexTip1 = null;
    let indexTip2 = null;
    if (result.landmarks && result.landmarks.length >= 2) {
      const landmarks1 = result.landmarks[0];
      const landmarks2 = result.landmarks[1];
      const isHandFist = (lms) => {
        const openness = this.calculateHandOpenness(lms);
        return openness < 0.28; // fist threshold
      };
      if (isHandFist(landmarks1) && isHandFist(landmarks2)) {
        isZoomActiveRaw = true;
        indexTip1 = landmarks1[9]; // Use middle MCP knuckle as stable center of fist
        indexTip2 = landmarks2[9];
      }
    }
    if (isZoomActiveRaw && indexTip1 && indexTip2) {
      smoothedGesture = 'Pointing_Up_Two_Hands';
    }

    // --- CONSECUTIVENESS DEBOUNCE FILTER ---
    // Only transition to the new gesture state if detected stably for 8 frames (~250ms)
    if (smoothedGesture === this.currentGesture) {
      this.candidateGesture = smoothedGesture;
      this.consecutiveFrames = 0;
    } else {
      if (smoothedGesture === this.candidateGesture) {
        this.consecutiveFrames++;
        if (this.consecutiveFrames >= this.consecutivenessThreshold) {
          console.log(`[GestureControl] Gesture stably transitioned: ${this.currentGesture} -> ${smoothedGesture}`);
          this.currentGesture = smoothedGesture;
          this.gestureConfidence = confidence;
          if (this.onGestureChange) {
            this.onGestureChange(smoothedGesture, confidence);
          }
          this.consecutiveFrames = 0;
        }
      } else {
        this.candidateGesture = smoothedGesture;
        this.consecutiveFrames = 1;
      }
    }
    // --- ACTIONS BASED ON STABILIZED GESTURE ---
    const isZoomActive = (this.currentGesture === 'Pointing_Up_Two_Hands');
    // Trigger zoom callback if active
    if (isZoomActive && result.landmarks && result.landmarks.length >= 2) {
      const tip1 = result.landmarks[0][9]; // Use middle MCP knuckle
      const tip2 = result.landmarks[1][9];
      const dist = Math.sqrt((tip1.x - tip2.x)**2 + (tip1.y - tip2.y)**2);
      if (this.onZoomChange) {
        this.onZoomChange(dist);
      }
    } else {
      if (this.onZoomChange) {
        this.onZoomChange(null);
      }
    }
    // Handle Rotation Gesture (Pointing_Up: index finger tip tracking)
    if (!isZoomActive && this.currentGesture === 'Pointing_Up' && landmarks) {
      const currentHandPos = { x: landmarks[8].x, y: landmarks[8].y };
      if (this.lastHandPos && this.inRotationMode) {
        const dx = currentHandPos.x - this.lastHandPos.x;
        const dy = currentHandPos.y - this.lastHandPos.y;
        if (this.onRotationChange) {
          this.onRotationChange(dx, dy);
        }
      }
      this.lastHandPos = currentHandPos;
      this.inRotationMode = true;
    } else {
      this.inRotationMode = false;
      this.lastHandPos = null;
    }
    // Handle Openness / Target Progress (Continuous mapping from Open Palm to Closed Fist)
    if (landmarks) {
      // Lock targetProgress to 0.0 if active stabilized OR incoming candidate gesture is Victory/Pointing_Up
      if (isZoomActive) {
        // Keep current targetProgress during zoom to prevent model from scattering/gathering
      } else if (
        this.currentGesture === 'Victory' || 
        this.currentGesture === 'Pointing_Up' ||
        smoothedGesture === 'Victory' ||
        smoothedGesture === 'Pointing_Up'
      ) {
        this.targetProgress = 0.0;
      } else {
        // Continuous openness mapping
        const openness = this.calculateHandOpenness(landmarks);
        
        // Stabilize progress changes with simple low-pass filter to prevent jumpiness
        const filterWeight = 0.25; // responsive yet smooth
        this.targetProgress = this.targetProgress * (1 - filterWeight) + openness * filterWeight;
        
        // Categorize gesture for display feedback
        let displayGesture = 'none';
        if (this.targetProgress > 0.70) {
          displayGesture = 'Open_Palm';
        } else if (this.targetProgress < 0.30) {
          displayGesture = 'Closed_Fist';
        }
        
        // Update currentGesture for UI display feedback if it transitions stably
        if (displayGesture !== 'none' && displayGesture !== this.currentGesture) {
          this.currentGesture = displayGesture;
          if (this.onGestureChange) {
            this.onGestureChange(displayGesture, confidence);
          }
        }
      }
    } else {
      // No hand in view: only reset to 0.0 if the stable gesture has transitioned to 'none'
      if (!isZoomActive && this.currentGesture === 'none') {
        this.targetProgress = 0.0;
      }
    }
  }
  /**
   * Calculate hand openness (0 = tight fist, 1 = fully open palm).
   * Uses scale-invariant finger length relative to palm size.
   */
  calculateHandOpenness(landmarks) {
    const wrist = landmarks[0];
    const middleMCP = landmarks[9];
    
    // Size of the palm
    const palmLength = Math.sqrt(
      (wrist.x - middleMCP.x)**2 + 
      (wrist.y - middleMCP.y)**2 + 
      (wrist.z - middleMCP.z)**2
    );
    
    if (palmLength < 0.001) return 0.5;
    // Check if each finger is extended to strictly enforce 5-finger open palm
    const isIndexExtended = this.isFingerExtended(landmarks, 8, 6, 5);
    const isMiddleExtended = this.isFingerExtended(landmarks, 12, 10, 9);
    const isRingExtended = this.isFingerExtended(landmarks, 16, 14, 13);
    const isPinkyExtended = this.isFingerExtended(landmarks, 20, 18, 17);
    
    const dThumbIndexMCP = Math.sqrt(
      (landmarks[4].x - landmarks[5].x)**2 +
      (landmarks[4].y - landmarks[5].y)**2 +
      (landmarks[4].z - landmarks[5].z)**2
    ) / palmLength;
    const isThumbExtended = dThumbIndexMCP > 0.58; // thumb extension check
    
    let extendedCount = 0;
    if (isIndexExtended) extendedCount++;
    if (isMiddleExtended) extendedCount++;
    if (isRingExtended) extendedCount++;
    if (isPinkyExtended) extendedCount++;
    if (isThumbExtended) extendedCount++;
    
    let multiplier = 0.0;
    if (extendedCount === 5) {
      multiplier = 1.0;
    } else if (extendedCount === 4) {
      multiplier = 0.5;
    }
    
    // Fingers: Index (5-8), Middle (9-12), Ring (13-16), Pinky (17-20)
    const bases = [5, 9, 13, 17];
    const tips = [8, 12, 16, 20];
    let totalRatio = 0.0;
    for (let j = 0; j < 4; j++) {
      const base = landmarks[bases[j]];
      const tip = landmarks[tips[j]];
      const dist = Math.sqrt(
        (tip.x - base.x)**2 + 
        (tip.y - base.y)**2 + 
        (tip.z - base.z)**2
      );
      totalRatio += dist / palmLength;
    }
    
    const avgRatio = totalRatio / 4;
    
    // Narrowed range to ensure palm opens fully to 100% and closes to 0% easily
    const minRatio = 0.48;
    const maxRatio = 0.72;
    
    const openness = (avgRatio - minRatio) / (maxRatio - minRatio);
    return Math.max(0, Math.min(1, openness)) * multiplier;
  }
  /**
   * Helper to determine if a finger is extended.
   * A finger is extended if its tip is further from the MCP joint than its PIP joint.
   */
  isFingerExtended(landmarks, tipIdx, pipIdx, mcpIdx) {
    const dTipToMCP = Math.sqrt(
      (landmarks[tipIdx].x - landmarks[mcpIdx].x)**2 +
      (landmarks[tipIdx].y - landmarks[mcpIdx].y)**2 +
      (landmarks[tipIdx].z - landmarks[mcpIdx].z)**2
    );
    const dPipToMCP = Math.sqrt(
      (landmarks[pipIdx].x - landmarks[mcpIdx].x)**2 +
      (landmarks[pipIdx].y - landmarks[mcpIdx].y)**2 +
      (landmarks[pipIdx].z - landmarks[mcpIdx].z)**2
    );
    return dTipToMCP > dPipToMCP * 1.3;
  }
  /**
   * Helper to determine if a finger is folded.
   * A finger is folded if its tip is close to the MCP joint relative to the PIP joint.
   */
  isFingerFolded(landmarks, tipIdx, pipIdx, mcpIdx) {
    const dTipToMCP = Math.sqrt(
      (landmarks[tipIdx].x - landmarks[mcpIdx].x)**2 +
      (landmarks[tipIdx].y - landmarks[mcpIdx].y)**2 +
      (landmarks[tipIdx].z - landmarks[mcpIdx].z)**2
    );
    const dPipToMCP = Math.sqrt(
      (landmarks[pipIdx].x - landmarks[mcpIdx].x)**2 +
      (landmarks[pipIdx].y - landmarks[mcpIdx].y)**2 +
      (landmarks[pipIdx].z - landmarks[mcpIdx].z)**2
    );
    return dTipToMCP < dPipToMCP * 1.1;
  }
  /**
   * Check if exactly two fingers (index and middle) are extended.
   * Helps trigger the Victory / Rotation gesture robustly.
   */
  isTwoFingersExtended(landmarks) {
    const isIndexExtended = this.isFingerExtended(landmarks, 8, 6, 5);
    const isMiddleExtended = this.isFingerExtended(landmarks, 12, 10, 9);
    const isRingFolded = this.isFingerFolded(landmarks, 16, 14, 13);
    const isPinkyFolded = this.isFingerFolded(landmarks, 20, 18, 17);
    return isIndexExtended && isMiddleExtended && isRingFolded && isPinkyFolded;
  }
  /**
   * Check if index finger is extended, and all other fingers folded.
   */
  isPointingUpGesture(landmarks) {
    const wrist = landmarks[0];
    const middleMCP = landmarks[9];
    const palmLength = Math.sqrt(
      (wrist.x - middleMCP.x)**2 + 
      (wrist.y - middleMCP.y)**2 + 
      (wrist.z - middleMCP.z)**2
    );
    if (palmLength < 0.001) return false;
    
    const isIndexExtended = this.isFingerExtended(landmarks, 8, 6, 5);
    const isMiddleFolded = this.isFingerFolded(landmarks, 12, 10, 9);
    const isRingFolded = this.isFingerFolded(landmarks, 16, 14, 13);
    const isPinkyFolded = this.isFingerFolded(landmarks, 20, 18, 17);
    
    // Thumb folded check: distance from thumb tip (4) to index base (5) should be small
    const dThumbIndexMCP = Math.sqrt(
      (landmarks[4].x - landmarks[5].x)**2 +
      (landmarks[4].y - landmarks[5].y)**2 +
      (landmarks[4].z - landmarks[5].z)**2
    ) / palmLength;
    const isThumbFolded = dThumbIndexMCP < 0.55;
    
    return isIndexExtended && isMiddleFolded && isRingFolded && isPinkyFolded && isThumbFolded;
  }
  /**
   * Check if the hand is held generally upright.
   * Filters out passive hand gestures (like resting chin/face on horizontal/tilted hands).
   */
  isHandUpright(landmarks) {
    const wrist = landmarks[0];
    const middleMCP = landmarks[9];
    const palmLength = Math.sqrt(
      (wrist.x - middleMCP.x)**2 + 
      (wrist.y - middleMCP.y)**2 + 
      (wrist.z - middleMCP.z)**2
    );
    if (palmLength < 0.001) return false;
    
    // Upright: wrist is physically below knuckles (wrist.y > middleMCP.y in normalized screen coords)
    // We require the vertical projection ratio to be at least 0.60 (corresponds to tilt angle < 53 degrees)
    return (wrist.y - middleMCP.y) / palmLength > 0.60;
  }
  /**
   * Get the most common gesture in the history buffer.
   */
  getMajorityGesture() {
    const counts = {};
    for (const g of this.gestureHistory) {
      counts[g] = (counts[g] || 0) + 1;
    }
    let maxCount = 0;
    let majority = 'none';
    for (const [gesture, count] of Object.entries(counts)) {
      if (count > maxCount) {
        maxCount = count;
        majority = gesture;
      }
    }
    return majority;
  }
  /**
   * Get the current target progress value.
   * @returns {number} 0 (gathered/fist) to 1 (scattered/palm)
   */
  getTargetProgress() {
    return this.targetProgress;
  }
  /**
   * Get current gesture info for display.
   */
  getGestureInfo() {
    return {
      gesture: this.currentGesture,
      confidence: this.gestureConfidence,
      icon: this.getGestureIcon(this.currentGesture),
      label: this.getGestureLabel(this.currentGesture),
    };
  }
  /**
   * Get the inline SVG symbol ID for a gesture.
   */
  getGestureIcon(gesture) {
    const map = {
      'Open_Palm': 'icon-hand-stop',
      'Closed_Fist': 'icon-hand-grab',
      'Pointing_Up': 'icon-hand-finger',
      'Pointing_Up_Two_Hands': 'icon-hand-grab',
      'Thumb_Up': 'icon-hand-stop',
      'Thumb_Down': 'icon-hand-stop',
      'Victory': 'icon-hand-two-fingers',
      'none': 'icon-hand-stop',
    };
    return map[gesture] || 'icon-hand-stop';
  }
  /**
   * Get label for gesture.
   */
  getGestureLabel(gesture) {
    const map = {
      'Open_Palm': '张开手掌 · 扩散',
      'Closed_Fist': '握拳 · 聚合',
      'Pointing_Up': '食指指向 · 控制视角旋转',
      'Pointing_Up_Two_Hands': '双拳控距 · 缩放模型大小',
      'Thumb_Up': '竖起拇指',
      'Victory': '剪刀手 · 切换3DGS/点云模式 (保持0.7秒)',
      'none': '等待检测...',
    };
    return map[gesture] || gesture;
  }
  /**
   * Pause gesture detection.
   */
  pause() {
    this.isRunning = false;
  }
  /**
   * Resume gesture detection.
   */
  resume() {
    if (this.isInitialized) {
      this.isRunning = true;
    }
  }
  /**
   * Clean up all resources.
   */
  destroy() {
    this.isRunning = false;
    this.isInitialized = false;
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.gestureRecognizer) {
      this.gestureRecognizer.close();
      this.gestureRecognizer = null;
    }
    if (this.videoElement) {
      this.videoElement.srcObject = null;
    }
  }
}
