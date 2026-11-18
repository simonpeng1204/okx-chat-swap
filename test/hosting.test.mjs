import assert from 'node:assert/strict';
import test from 'node:test';
async function findPublicIcon(...args) {
  const hosting = await import('../hosting.mjs').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof hosting.findPublicIcon, 'function', 'the public host gate must exist');
  return hosting.findPublicIcon(...args);
}

const base = 'https://simonpeng1204.github.io/test-only/';
const config = { publicBase: base };
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 180, 0, 0, 0, 180]);

test('an unconfigured build or the wrong origin/path makes no icon request', async () => {
  for (const [page, settings] of [
    ['http://localhost:8000/', config], [base, { publicBase: null }],
    [base.replace('/test-only/', '/another/'), config], [base.replace('https:', 'http:'), config],
  ]) {
    assert.equal(await findPublicIcon(page, settings, () => assert.fail('unexpected network')), null);
  }
});

test('the configured GitHub Pages path must serve the PNG without credentials or redirects', async () => {
  const url = base + 'icon.png';
  const fetchIcon = async (requested, options) => {
    assert.equal(requested, url);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return { ok: true, url, headers: new Headers({ 'Content-Type': 'image/png' }),
      arrayBuffer: async () => png.buffer };
  };
  assert.equal(await findPublicIcon(base + 'index.html', config, fetchIcon), url);
  assert.equal(await findPublicIcon(base, config, async () => ({ ok: false })), null);
  assert.equal(await findPublicIcon(base, config, async () => ({
    ...await fetchIcon(url, { credentials: 'omit', redirect: 'error' }),
    arrayBuffer: async () => new Uint8Array(24).buffer,
  })), null);
});
