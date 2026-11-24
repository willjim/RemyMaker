const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

// Evaluate the app's real pure timing functions without importing its browser UI,
// renderer, or other runtime dependencies. Keeping these functions sourced from
// app.js makes the tests exercise production logic rather than a duplicate.
function extractFunction(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Expected function ${name} in js/app.js`);
  const nextFunction = appSource.indexOf('\nfunction ', start + 1);
  assert.notEqual(nextFunction, -1, `Expected a function boundary after ${name}`);
  return appSource.slice(start, nextFunction);
}

const timingFunctions = [
  'getCurrentFlightDuration',
  'getActiveParticleEffectDuration',
  'evaluateEffectAtSeconds',
  'evaluateRendererTransitionAtSeconds',
  'getRendererAtTime',
  'getManualCurveProgress',
  'createMonotoneTimeDerivatives',
  'getRendererBlendAtSeconds',
].map(extractFunction).join('\n');

const context = vm.createContext({
  state: {
    settings: { presetFlight: 'none', scatterEffect: 0, renderer: 'particles' },
    keyframes: [{}, {}, {}],
    cameraKeyframeTimes: [0, 0.2, 1],
    flightTiming: {
      mode: 'manual',
      totalDuration: 9,
      segmentDurations: [1, 4],
      presetDurations: {},
      particle: {
        start: 0,
        duration: null,
        direction: 'gather',
        transitionDuration: 1.5,
      },
      appearance: { mode: 'fade', direction: 'all', overlayEnabled: false },
    },
  },
  THREE: { MathUtils: { clamp: (value, min, max) => Math.max(min, Math.min(max, value)), lerp: (a,b,t) => a+(b-a)*t } },
  CUSTOM_KEYFRAME_SEGMENT_DURATION: 2,
  SPATIAL_EFFECT_GATHER_DURATION: 4.75,
  EXPORT_GATHER_DURATION: 2.5,
});

vm.runInContext(`${timingFunctions}\nglobalThis.timing = {
  getCurrentFlightDuration,
  evaluateEffectAtSeconds,
  evaluateRendererTransitionAtSeconds,
  getRendererAtTime,
  getManualCurveProgress,
  getRendererBlendAtSeconds,
};`, context, { filename: 'js/app.js timing helpers' });

test('manual segment durations define the exact flight timeline', () => {
  const { state } = context;
  const total = state.flightTiming.segmentDurations.reduce((sum, value) => sum + value, 0);
  let elapsed = 0;
  state.cameraKeyframeTimes = [0, ...state.flightTiming.segmentDurations.map((value) => {
    elapsed += value;
    return elapsed / total;
  })];
  assert.equal(context.timing.getCurrentFlightDuration(), 5);
  assert.equal(context.timing.getManualCurveProgress(0), 0);
  assert.equal(context.timing.getManualCurveProgress(0.2), 0.5);
  assert.equal(context.timing.getManualCurveProgress(1), 1);

  let previous = -Infinity;
  for (let sample = 0; sample <= 100; sample++) {
    const value = context.timing.getManualCurveProgress(sample / 100);
    assert.ok(value >= previous - 1e-12, `manual curve reversed at sample ${sample}`);
    previous = value;
  }
});

test('effects longer than the flight are cut without speeding up', () => {
  context.state.flightTiming.particle.start = 1;
  context.state.flightTiming.particle.duration = 10;
  context.state.flightTiming.particle.direction = 'scatter';
  assert.equal(context.timing.getCurrentFlightDuration(), 5);
  assert.equal(context.timing.evaluateEffectAtSeconds(5).progress, .4);
  assert.equal(context.timing.evaluateEffectAtSeconds(5.1).active, false);
});

test('interrupted renderer transitions are continuous and frame-rate independent', () => {
  const events = [{ time: 1, renderer: 'spark', duration: 2 }, { time: 2, renderer: 'particles', duration: 1 }];
  assert.equal(context.timing.getRendererBlendAtSeconds(1, 'particles', events), 0);
  assert.equal(context.timing.getRendererBlendAtSeconds(2, 'particles', events), .5);
  assert.equal(context.timing.getRendererBlendAtSeconds(2.5, 'particles', events), .25);
  assert.equal(context.timing.getRendererBlendAtSeconds(3, 'particles', events), 0);
});

test('gather effect reaches exact start/end nodes and clamps outside its interval', () => {
  const { state } = context;
  state.flightTiming.particle.start = 1;
  state.flightTiming.particle.duration = 4;
  state.flightTiming.particle.direction = 'gather';

  const before = context.timing.evaluateEffectAtSeconds(0.99);
  const start = context.timing.evaluateEffectAtSeconds(1);
  const middle = context.timing.evaluateEffectAtSeconds(3);
  const end = context.timing.evaluateEffectAtSeconds(5);
  const after = context.timing.evaluateEffectAtSeconds(5.01);
  assert.equal(before.active, false);
  assert.equal(start.active, true);
  assert.equal(start.progress, 1);
  assert.equal(middle.progress, 0.5);
  assert.equal(end.active, true);
  assert.equal(end.progress, 0);
  assert.equal(after.active, false);
  assert.equal(after.progress, 0);
});

test('scatter and gather-scatter directions have exact endpoints and midpoint', () => {
  const { state } = context;
  state.flightTiming.particle.start = 0;
  state.flightTiming.particle.duration = 4;
  state.flightTiming.particle.direction = 'scatter';
  assert.equal(context.timing.evaluateEffectAtSeconds(0).progress, 0);
  assert.equal(context.timing.evaluateEffectAtSeconds(2).progress, 0.5);
  assert.equal(context.timing.evaluateEffectAtSeconds(4).progress, 1);

  state.flightTiming.particle.direction = 'gather-scatter';
  assert.equal(context.timing.evaluateEffectAtSeconds(0).progress, 1);
  assert.equal(context.timing.evaluateEffectAtSeconds(2).progress, 0);
  assert.equal(context.timing.evaluateEffectAtSeconds(4).progress, 1);
});

test('renderer snapshots and transition amounts are timestamp-based, not frame-based', () => {
  const timeline = [
    { time: 2, renderer: 'spark', duration: 1, type: 'fly', direction: 'left' },
    { time: 4, renderer: 'particles', duration: 2, type: 'fade', direction: 'all' },
    { time: 7, renderer: 'spark', duration: 0.5, type: 'fade', direction: 'right' },
  ];
  const rendererAt = time => context.timing.getRendererAtTime(time, 'particles', timeline);
  assert.equal(rendererAt(1.999), 'particles');
  assert.equal(rendererAt(2), 'spark');
  assert.equal(rendererAt(4), 'particles');
  assert.equal(rendererAt(8), 'spark');

  const before = context.timing.evaluateRendererTransitionAtSeconds(3.5, 'particles', timeline);
  const start = context.timing.evaluateRendererTransitionAtSeconds(4, 'particles', timeline);
  const middle = context.timing.evaluateRendererTransitionAtSeconds(5, 'particles', timeline);
  const end = context.timing.evaluateRendererTransitionAtSeconds(6, 'particles', timeline);
  assert.equal(before.event.time, 2);
  assert.equal(start.event.time, 4);
  assert.equal(start.from, 'spark');
  assert.equal(start.to, 'particles');
  assert.equal(start.amount, 0);
  assert.equal(middle.amount, 0.5);
  assert.equal(end.amount, 1);
  assert.equal(middle.style, 'fade');

  // Re-evaluating the same timestamp models any frame rate: the snapshot is
  // determined solely by seconds and the saved renderer events.
  const repeated = context.timing.evaluateRendererTransitionAtSeconds(5, 'particles', timeline);
  assert.equal(repeated.amount, middle.amount);
  assert.equal(repeated.event, middle.event);
});
