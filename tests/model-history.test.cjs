const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');

test('share page title ignores fake markup and decodes HTML escapes', async () => {
  const { extractPageTitle } = await import('../functions/resolve.js');
  const html = '<!-- <title>Old</title> --><script>"<title>Fake</title>"</script>'
    + '<TITLE class="page"> Flowers &amp; Trees &#x1F333; \n in 3D </TITLE>';
  assert.equal(extractPageTitle(html), 'Flowers & Trees 🌳 in 3D');
  assert.equal(extractPageTitle('<script>"<title>Fake</title>"</script>'), '');
});

test('the built-in demo does not change later models’ particle settings', () => {
  const source = readFileSync(join(__dirname, '../js/app.js'), 'utf8');
  const apply = source.slice(source.indexOf('function applyModelParticleDefaults('),
    source.indexOf('/**\n * Process a SOG'));
  const state = { settings: { pointSize: 0.15, particleBrightness: 0.9 }, demoParticleSettingsBackup: null };
  const dom = {
    settingPointSize: { max: '0.30' }, settingPointSizeVal: {},
    settingParticleBrightness: { max: '2.00' }, settingParticleBrightnessVal: {},
  };
  const run = isDemo => runInNewContext(apply + '\napplyModelParticleDefaults(isDemo);', { state, dom, isDemo });
  run(false);
  assert.equal(state.settings.pointSize, 0.15);
  run(true);
  assert.equal(state.settings.pointSize, 0.3);
  assert.equal(dom.settingParticleBrightnessVal.textContent, '2.00');
  state.settings.pointSize = 0.22;
  run(true);
  run(false);
  assert.deepEqual(state.settings, { pointSize: 0.15, particleBrightness: 0.9 });
  assert.equal(dom.settingPointSizeVal.textContent, '0.15');
  assert.equal(dom.settingParticleBrightnessVal.textContent, '0.90');
});
