import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, SourceTextModule } from 'node:vm';

class Element {
  constructor(tag) {
    this.disabled = /\bdisabled\b/.test(tag);
    this.hidden = /\bhidden\b/.test(tag);
    this.textContent = '';
    this.value = '';
    this.listeners = new Map();
  }

  addEventListener(event, callback) {
    this.listeners.set(event, callback);
  }

  removeAttribute(attribute) {
    delete this[attribute];
  }

  async fire(event, data = {}) {
    await this.listeners.get(event)({
      currentTarget: this, preventDefault() {}, isTrusted: false, ...data,
    });
  }
}

test('the built page boots untouched and keeps a validated fixture away from the SDK', async () => {
  const root = new URL('../dist/', import.meta.url);
  const html = await readFile(new URL('index.html', root), 'utf8');
  const envelopes = JSON.parse(await readFile(new URL('./python-envelopes.json', import.meta.url), 'utf8'));
  const entry = html.match(/<script type="module" src="([^"]+)">/)[1];
  const elements = new Map([...html.matchAll(/<[^>]+ id="([^"]+)"[^>]*>/g)]
    .map(([tag, id]) => [id, new Element(tag)]));
  assert.equal(elements.get('connect').disabled, true);
  assert.equal(elements.get('sign').disabled, true);

  const sdkLoads = [];
  const resourceRequests = [];
  let instant = Date.parse('2026-11-18T12:00:00+10:00');
  let tick;
  const context = createContext({
    Date: class extends Date { static now() { return instant; } },
    TextEncoder, URL, crypto,
    location: { href: 'http://127.0.0.1:8000/' },
    document: { getElementById: id => elements.get(id) },
    setInterval(callback) { tick = callback; },
    fetch(url) { resourceRequests.push(url); },
  });
  const modules = new Map();
  async function load(url) {
    if (!modules.has(url.href)) {
      modules.set(url.href, new SourceTextModule(await readFile(url, 'utf8'), {
        context, identifier: url.href,
        importModuleDynamically(specifier) {
          sdkLoads.push(specifier);
          throw new Error('No SDK load allowed in this test');
        },
      }));
    }
    return modules.get(url.href);
  }
  const app = await load(new URL(entry, root));
  await app.link((specifier, referencingModule) => load(new URL(specifier, referencingModule.identifier)));
  await app.evaluate();

  const get = id => elements.get(id);
  assert.match(get('wallet-status').textContent, /尚不可连接/);
  assert.equal(get('details').hidden, true);
  await get('connect').fire('click', { isTrusted: true });
  await get('sign').fire('click', { isTrusted: true });

  get('preview-json').value = JSON.stringify(envelopes.fixture);
  get('pinned-hash').value = envelopes.fixture.sha256;
  await get('review-form').fire('submit');
  assert.match(get('review-status').textContent, /测试夹具/);
  assert.equal(get('details').hidden, false);
  assert.equal(get('amount-raw').textContent, '125000000');
  assert.equal(get('impact').textContent, '-0.25%');
  assert.equal(get('digest').textContent, envelopes.fixture.sha256);
  assert.equal(get('connect').disabled, true);
  assert.equal(get('sign').disabled, true);
  await get('connect').fire('click', { isTrusted: true });
  await get('sign').fire('click', { isTrusted: true });

  instant += 120_000;
  tick();
  assert.match(get('review-status').textContent, /已过期/);
  assert.equal(get('countdown').textContent, '已过期');
  get('pinned-hash').value = '0'.repeat(64);
  await get('pinned-hash').fire('input');
  assert.equal(get('details').hidden, true);
  await get('review-form').fire('submit');
  assert.match(get('review-status').textContent, /哈希不匹配/);
  assert.equal(get('connect').disabled, true);
  assert.equal(get('sign').disabled, true);
  assert.deepEqual(sdkLoads, []);
  assert.deepEqual(resourceRequests, []);
});
