const assert = require('node:assert/strict');
const test = require('node:test');

const helpers = import('../js/flightTimeline.js');

test('moving a middle keyframe preserves clip duration and minimum neighbors', async () => {
  const { getManualTimelineTimes, moveTimelineKeyframe } = await helpers;
  const times = getManualTimelineTimes([1, 4]);
  assert.deepEqual(times, [0, 1, 5]);
  assert.deepEqual(moveTimelineKeyframe(times, 1, 2), [0, 2, 5]);
  assert.deepEqual(moveTimelineKeyframe(times, 1, -1), [0, 0.05, 5]);
  assert.deepEqual(moveTimelineKeyframe(times, 1, 8), [0, 4.95, 5]);
  assert.deepEqual(moveTimelineKeyframe(times, 0, 2), times);
  assert.deepEqual(moveTimelineKeyframe(times, 2, 4), times);
});

test('rescaling a clip fits all keyframes even below their minimum total', async () => {
  const { MIN_TIMELINE_SEGMENT, normalizeManualTimelineTimes, scaleTimelineTimes } = await helpers;
  assert.deepEqual(scaleTimelineTimes([0, 1, 5], 10), [0, 2, 10]);
  const tight = normalizeManualTimelineTimes([0, 0.02, 0.04, 0.07], 0.08);
  assert.ok(Math.abs(tight.at(-1) - 0.15) < 1e-12);
  for (let index = 1; index < tight.length; index++) {
    assert.ok(tight[index] - tight[index - 1] >= MIN_TIMELINE_SEGMENT - 1e-12);
  }
});

test('transition defaults replace the timeline and preview restores its transport', async t => {
  const { createFlightTimeline } = await helpers;
  const actions = [];
  const selectors = new Map();
  const listeners = new Map();
  const node = () => ({
    attributes: {}, dataset: {}, style: { setProperty() {} }, parentElement: {}, scrollLeft: 0,
    setAttribute(name, value) { this.attributes[name] = value; },
    replaceChildren() {}, append() {}, addEventListener() {}, focus() { this.focused = true; },
  });
  const lookup = selector => {
    if (!selectors.has(selector)) selectors.set(selector, node());
    return selectors.get(selector);
  };
  const controls = attribute => [...panel.innerHTML.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'g'))].map(([, value]) => {
    const control = lookup(`[${attribute}="${value}"]`);
    control.dataset[{
      'data-flight-view': 'flightView', 'data-flight-action': 'flightAction', 'data-flight-field': 'flightField',
    }[attribute]] = value;
    return control;
  });
  const panel = {
    innerHTML: '', contains: () => false, querySelector: lookup,
    querySelectorAll: selector => selector === '[data-marker]' ? [] : controls(selector.slice(1, -1)),
    addEventListener: (event, listener) => listeners.set(event, listener),
    closest: () => ({ classList: { add() {} } }),
  };
  const documentBefore = global.document;
  global.document = { createElement: node };
  t.after(() => { global.document = documentBefore; });

  const instance = createFlightTimeline(panel, action => actions.push(action));
  const view = {
    lang: 'zh', duration: 0, time: 0, keyframes: [], events: [], particle: { enabled: false },
    transitionDefaults: { duration: 1.5, mode: 'fade', direction: 'all', overlayEnabled: false },
  };
  instance.update(view);
  assert.match(panel.innerHTML, /class="flight-timeline-menu"[^>]*>[\s\S]*?aria-controls="flight-transition-defaults"[^>]*>转场默认设置<\/button>\s*<\/div>/);
  assert.equal(lookup('#flight-timeline-main').hidden, false);
  assert.equal(lookup('#flight-transition-defaults').hidden, true);

  const menu = name => lookup(`[data-flight-view="${name}"]`);
  const click = button => listeners.get('click')({ target: { closest: () => button } });
  click(menu('defaults'));
  assert.equal(lookup('#flight-timeline-main').hidden, true);
  assert.equal(lookup('#flight-transition-defaults').hidden, false);
  assert.equal(menu('defaults').attributes['aria-pressed'], 'true');
  const duration = lookup('[data-flight-field="default-duration"]');
  duration.type = 'number';
  duration.valueAsNumber = 2;
  listeners.get('change')({ target: duration });
  assert.deepEqual(actions, [{ type: 'set-transition-defaults', changes: { duration: 2 } }]);

  listeners.get('keydown')({ key: 'Escape', preventDefault() {} });
  assert.equal(lookup('#flight-transition-defaults').hidden, true);
  assert.equal(menu('timeline').focused, true);

  click(menu('edit'));
  assert.equal(lookup('#flight-timeline-editing').hidden, false);
  instance.update({ ...view, playing: true });
  assert.equal(lookup('#flight-timeline-editing').hidden, true);
  assert.equal(lookup('#flight-timeline-main').hidden, false);
  assert.equal(menu('defaults').disabled, true);
});
