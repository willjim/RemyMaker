const assert = require('node:assert/strict');
const test = require('node:test');

const helper = import('../js/professionalMode.js');

test('the fifth consecutive title click enables professional mode only once', async () => {
  const { createProfessionalMode } = await helper;
  const store = new Map();
  const options = { read: key => store.get(key), write: (key, value) => store.set(key, value) };
  const mode = createProfessionalMode(options);
  assert.equal(mode.enabled, false);
  for (let index = 0; index < 4; index++) assert.equal(mode.click(index * 100), false);
  assert.equal(mode.enabled, false);
  assert.equal(mode.click(400), true);
  assert.equal(mode.enabled, true);
  assert.equal(mode.click(500), false);
  assert.equal(store.size, 1);
  assert.equal(createProfessionalMode(options).enabled, true);
  store.clear();
  assert.equal(createProfessionalMode(options).enabled, false);
});

test('waiting or clicking elsewhere clears the partial activation sequence', async () => {
  const { createProfessionalMode } = await helper;
  const mode = createProfessionalMode({ read: () => null, write: () => {} });
  [0, 100, 200, 300].forEach(time => mode.click(time));
  assert.equal(mode.click(2100), false);
  [2200, 2300, 2400].forEach(time => mode.click(time));
  mode.reset();
  [2500, 2600, 2700, 2800].forEach(time => assert.equal(mode.click(time), false));
  assert.equal(mode.click(2900), true);
});

test('denied browser storage does not prevent session-only activation', async () => {
  const { createProfessionalMode } = await helper;
  const blocked = () => { throw new Error('Storage denied'); };
  const mode = createProfessionalMode({ read: blocked, write: blocked });
  assert.equal(mode.enabled, false);
  [0, 100, 200, 300].forEach(time => mode.click(time));
  assert.equal(mode.click(400), true);
  assert.equal(mode.enabled, true);
});
