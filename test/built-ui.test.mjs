import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { decodeBase58 } from '../solana-wire.mjs';
import { toWalletTransaction } from '../wallet-sdk.mjs';
import { vectorEnvelope } from './semantics-vectors.mjs';

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

async function loadPage({ publicBase, sdk } = {}) {
  const root = new URL('../dist/', import.meta.url);
  const html = await readFile(new URL('index.html', root), 'utf8');
  const png = await readFile(new URL('icon.png', root));
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
    TextEncoder, URL, crypto, btoa, AbortSignal,
    location: { href: publicBase ?? 'http://127.0.0.1:8000/' },
    document: { getElementById: id => elements.get(id) },
    setInterval(callback) { tick = callback; },
    async fetch(url) {
      resourceRequests.push(url);
      if (url !== publicBase + 'icon.png') throw new Error('No network in the UI test');
      return { ok: true, url, headers: new Headers({ 'Content-Type': 'image/png' }), arrayBuffer: async () => png };
    },
  });
  const modules = new Map();
  async function load(url) {
    if (!modules.has(url.href)) {
      const config = publicBase && url.pathname.endsWith('/deployment.mjs');
      const source = config ? 'export const deployment = { publicBase: ' + JSON.stringify(publicBase) + ' };'
        : await readFile(url, 'utf8');
      modules.set(url.href, new SourceTextModule(source, {
        context, identifier: url.href,
        async importModuleDynamically(specifier) {
          sdkLoads.push(specifier);
          if (specifier !== './wallet-sdk.mjs' || !sdk) throw new Error('No SDK load allowed in this test');
          const mock = new SyntheticModule(Object.keys(sdk), function () {
            for (const [name, value] of Object.entries(sdk)) this.setExport(name, value);
          }, { context });
          await mock.link(() => {});
          await mock.evaluate();
          return mock;
        },
      }));
    }
    return modules.get(url.href);
  }
  const app = await load(new URL(entry, root));
  await app.link((specifier, referencingModule) => load(new URL(specifier, referencingModule.identifier)));
  await app.evaluate();
  await new Promise(resolve => setImmediate(resolve));
  return { get: id => elements.get(id), sdkLoads, resourceRequests, elapsed(ms) { instant += ms; tick(); } };
}

async function importPreview(get, envelope) {
  const text = JSON.stringify(envelope);
  get('preview-file').files = [{ size: Buffer.byteLength(text), text: async () => text }];
  await get('preview-file').fire('change');
  get('pinned-hash').value = envelope.sha256;
  await get('review-form').fire('submit');
}

test('the built page boots untouched and keeps a validated fixture away from the SDK', async () => {
  const envelopes = JSON.parse(await readFile(new URL('./python-envelopes.json', import.meta.url), 'utf8'));
  const { get, sdkLoads, resourceRequests, elapsed } = await loadPage();
  assert.match(get('wallet-status').textContent, /尚不可连接/);
  assert.equal(get('details').hidden, true);
  await get('connect').fire('click', { isTrusted: true });
  await get('sign').fire('click', { isTrusted: true });

  await importPreview(get, envelopes.fixture);
  assert.match(get('review-status').textContent, /测试夹具/);
  assert.equal(get('details').hidden, false);
  assert.equal(get('amount-raw').textContent, '125000000');
  assert.equal(get('impact').textContent, '-0.25%');
  assert.equal(get('digest').textContent, envelopes.fixture.sha256);
  assert.equal(get('connect').disabled, true);
  assert.equal(get('sign').disabled, true);
  await get('connect').fire('click', { isTrusted: true });
  await get('sign').fire('click', { isTrusted: true });

  elapsed(120_000);
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

test('built confirmation gates physical clicks and hands exactly the reviewed v0 bytes to a wallet double', async () => {
  const checked = vectorEnvelope('v0_writable_and_readonly');
  const recipient = checked.preview.binding.recipient;
  const chain = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  const publicBase = 'https://simonpeng1204.github.io/okx-chat-swap/';
  const sdkCalls = [];
  const { get, sdkLoads, resourceRequests, elapsed } = await loadPage({
    publicBase,
    sdk: {
      OKXUniversalProvider: { async init() {
        sdkCalls.push('init');
        return { async connect() {
          sdkCalls.push('connect');
          return { namespaces: { solana: { accounts: [chain + ':' + recipient] } } };
        } };
      } },
      OKXSolanaProvider: class {
        getAccount() { return { address: recipient }; }
        async signTransaction(transaction, requestedChain) {
          sdkCalls.push(['sign', requestedChain, Array.from(transaction.serialize())]);
        }
      },
      toWalletTransaction,
    },
  });
  await importPreview(get, vectorEnvelope('unknown_router'));
  assert.match(get('review-status').textContent, /unimplemented_program:/);
  await get('connect').fire('click', { isTrusted: true });
  assert.deepEqual(sdkLoads, []);

  await importPreview(get, checked);
  assert.match(get('review-status').textContent, /已通过离线指令审查/);
  assert.equal(get('connect').disabled, false);
  assert.equal(get('sign').disabled, true);
  await get('connect').fire('click');
  assert.deepEqual(sdkLoads, []);
  await get('connect').fire('click', { isTrusted: true });
  assert.deepEqual(sdkCalls, ['init', 'connect']);
  assert.equal(get('sign').disabled, false);
  await get('sign').fire('click');
  assert.equal(sdkCalls.length, 2);
  await get('sign').fire('click', { isTrusted: true });
  const wire = decodeBase58(checked.preview.unsigned.tx.data, 1683);
  assert.deepEqual(sdkCalls[2], ['sign', chain, Array.from(wire)]);
  elapsed(120_000);
  assert.equal(get('sign').disabled, true);
  await get('sign').fire('click', { isTrusted: true });
  assert.equal(sdkCalls.length, 3);
  assert.deepEqual(resourceRequests, [publicBase + 'icon.png']);
});

test('SDK bridge preserves the reviewed legacy packet and refuses trailing bytes', () => {
  const wire = decodeBase58(vectorEnvelope('legacy_exact_in').preview.unsigned.tx.data, 1683);
  assert.deepEqual(toWalletTransaction(wire).serialize(), wire);
  assert.throws(() => toWalletTransaction(Uint8Array.from([...wire, 1])));
});
