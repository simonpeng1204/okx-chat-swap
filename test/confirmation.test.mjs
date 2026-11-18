import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const now = Date.parse('2026-11-18T12:00:00+10:00');
const CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const mockIcon = 'https://preview.invalid/icon.png';
const { dry, fixture } = JSON.parse(readFileSync(new URL('./python-envelopes.json', import.meta.url)));

const reviewFor = async () => {
  const { inspectPreview } = await import('../confirmation.mjs').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof inspectPreview, 'function', 'the confirmation validator must exist');
  return inspectPreview;
};

// Mock API payloads use only ASCII, and the captured Python envelopes cover Unicode.
function seal(preview) {
  const keys = new Set();
  JSON.stringify(preview, (key, value) => {
    keys.add(key);
    return value;
  });
  const canonical_json = JSON.stringify(preview, [...keys].sort());
  return { preview, canonical_json, sha256: createHash('sha256').update(canonical_json).digest('hex') };
}

function mockApiPayload() {
  const payload = structuredClone(fixture.preview);
  Object.assign(payload, { source: 'okx_dex_api', dry_run: false, notice: 'Mock response' });
  for (const quote of [payload.quote, payload.unsigned.routerResult]) {
    delete quote.fromToken.tokenSymbol;
    delete quote.toToken.tokenSymbol;
  }
  // Synthetic packet with empty signatures and zero instructions.
  payload.unsigned.tx.data = 'E3cqE89t5PMHL1KorzdJScrGm6TiKhprP5EGuXzyCWgQjBJVUQVxLYFefzwRjwWFJANiXnndE61HkxT1vG14J'
    + 'eCs8L3PNhb2zMZXHQpx5xMTogVqaB8wrjkfezdKavSsapHHDRnCEaWmMDAoVdHXTeUUZeffD2gdAx5q1BxBabcEpq9QJq96fH';
  return payload;
}

async function review(envelope, pin = envelope.sha256, time = now) {
  return (await reviewFor())(JSON.stringify(envelope), pin, time);
}

test('loads existing Python fixture for review and forbids both wallet requests', async () => {
  const result = await review(fixture);
  assert.equal(result.status, 'fixture');
  assert.equal(result.payload.binding.amountRaw, '125000000');
  assert.equal(result.payload.quote.priceImpactPercent, '-0.25');
  assert.equal(result.canConnect, false);
});

test('dry-run is readable and cannot connect', async () => {
  const result = await review(dry);
  assert.equal(result.status, 'dry_run');
  assert.equal(result.canConnect, false);
});

test('at the expiry instant, both wallet requests are blocked', async () => {
  const result = await review(seal(mockApiPayload()), undefined, now + 120_000);
  assert.equal(result.status, 'expired');
  assert.equal(result.canConnect, false);
});

test('mismatched canonical JSON and an independently pinned hash both fail closed', async () => {
  const original = seal(mockApiPayload());
  const changed = structuredClone(original);
  changed.preview.binding.recipient = changed.preview.binding.toMint;
  assert.equal((await review(changed)).status, 'hash_mismatch');
  const resealed = seal(changed.preview);
  assert.equal((await review(resealed, original.sha256)).status, 'hash_mismatch');
  assert.equal((await review(original, '')).status, 'hash_required');
});

test('independently pinned but inconsistent binding is refused', async () => {
  const payload = mockApiPayload();
  payload.binding.amountRaw = '125000001';
  const result = await review(seal(payload));
  assert.equal(result.status, 'invalid');
  assert.equal(result.canConnect, false);
});

test('fixture sentinel remains blocked even if presented as API data', async () => {
  const payload = mockApiPayload();
  payload.unsigned.tx.data = 'FIXTURE_UNSIGNED';
  const result = await review(seal(payload));
  assert.equal(result.status, 'fixture_material');
  assert.equal(result.canConnect, false);
});

test('quote-only preview is displayable with missing price impact and cannot connect', async () => {
  const payload = mockApiPayload();
  payload.unsigned = null;
  payload.quote.priceImpactPercent = null;
  const result = await review(seal(payload));
  assert.equal(result.status, 'quote_only');
  assert.equal(result.canConnect, false);
});

async function walletSetup(options = {}) {
  const payload = mockApiPayload();
  const envelope = seal(payload);
  const result = await review(envelope);
  assert.equal(result.status, 'unsigned_unreviewed');
  assert.equal(result.canConnect, true);
  const { createWalletController } = await import('../wallet.mjs');
  const calls = [];
  let address = payload.binding.recipient;
  let time = now;
  const wallet = createWalletController({
    getPreview: () => result,
    getIcon: () => mockIcon,
    now: () => time,
    loadSdk: async () => ({
      OKXUniversalProvider: {
        async init(config) {
          calls.push(['init', config.dappMetaData.icon]);
          await options.duringInit?.();
          return {
            async connect(params) {
              calls.push(['connect', params.namespaces.solana.chains]);
              return { namespaces: { solana: { accounts: [CHAIN + ':' + address] } } };
            },
          };
        },
      },
      OKXSolanaProvider: class {
        getAccount(chain) {
          assert.equal(chain, CHAIN);
          return { address };
        }
        async signTransaction(tx, chain) {
          calls.push(['sign', tx, chain]);
        }
      },
    }),
    ...options,
  });
  return { wallet, calls, payload, setAddress: value => { address = value; },
    setTime: value => { time = value; } };
}

test('constructing the controller and displaying readiness have no wallet side effects', async () => {
  const { wallet, calls } = await walletSetup();
  assert.equal(wallet.availability().connect, true);
  assert.equal(wallet.availability().sign, false);
  assert.deepEqual(calls, []);
});

test('invalid previews and an unavailable icon block direct requests too', async () => {
  const fixtureReview = await review(fixture);
  for (const options of [{ getIcon: () => null }, { getPreview: () => fixtureReview }]) {
    const { wallet, calls } = await walletSetup(options);
    assert.equal(wallet.availability().connect, false);
    assert.equal(wallet.availability().sign, false);
    await assert.rejects(wallet.connect());
    await assert.rejects(wallet.sign());
    assert.deepEqual(calls, []);
  }
});

test('only the explicit connect call initializes the SDK and requests Solana mainnet', async () => {
  const { wallet, calls, payload } = await walletSetup();
  assert.equal(await wallet.connect(), payload.binding.recipient);
  await assert.rejects(wallet.sign());
  assert.deepEqual(calls, [['init', mockIcon], ['connect', [CHAIN]]]);
});

test('rechecks expiry after asynchronous SDK initialization', async () => {
  const setup = await walletSetup({ duringInit: () => setup.setTime(now + 120_000) });
  await assert.rejects(setup.wallet.connect());
  assert.deepEqual(setup.calls, [['init', mockIcon]]);
});

test('wallet account must match the bound recipient before signing', async () => {
  const { wallet, calls, payload, setAddress } = await walletSetup({
    reviewTransaction: () => Object.freeze({ mock: 'reviewed transaction' }),
  });
  await wallet.connect();
  setAddress(payload.binding.toMint);
  assert.equal(wallet.availability().sign, false);
  await assert.rejects(wallet.sign());
  assert.equal(calls.some(([name]) => name === 'sign'), false);
});

test('trusted review returns the transaction handed to the mock SDK on a separate call', async () => {
  const tx = Object.freeze({ mock: 'reviewed transaction' });
  const { wallet, calls, payload } = await walletSetup({
    reviewTransaction(preview) {
      assert.equal(preview.unsigned.tx.data, payload.unsigned.tx.data);
      return tx;
    },
  });
  await wallet.connect();
  assert.equal(calls.length, 2);
  assert.equal(wallet.availability().sign, true);
  await wallet.sign();
  assert.deepEqual(calls.at(-1), ['sign', tx, CHAIN]);
});

test('Base58 without empty Solana signature slots cannot trigger a wallet request', async () => {
  const payload = mockApiPayload();
  payload.unsigned.tx.data = '2'.repeat(160);
  const result = await review(seal(payload));
  assert.equal(result.status, 'invalid');
  assert.equal(result.canConnect, false);
});

test('an expired malformed envelope cannot be shown as verified transaction details', async () => {
  const payload = mockApiPayload();
  payload.source = 'other';
  const result = await review(seal(payload), undefined, now + 120_000);
  assert.equal(result.status, 'invalid');
  assert.equal(result.payload, undefined);
});

test('rolling the clock back before creation locks the existing selection', async () => {
  const { wallet, calls, setTime } = await walletSetup();
  setTime(now - 1000);
  assert.equal(wallet.availability().connect, false);
  await assert.rejects(wallet.connect());
  assert.deepEqual(calls, []);
});
