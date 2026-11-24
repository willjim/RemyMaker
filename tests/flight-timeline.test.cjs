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
