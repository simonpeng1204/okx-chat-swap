import { pubkey, unsignedPacket } from './solana-wire.mjs';
import { reviewSemantics } from './semantics.mjs';

const DEX_NOTICE = 'OKX DEX API 报价材料。未签名交易须通过链上指令语义审查。';
const reviewedWires = new WeakMap();
const MAX_U64 = 2n ** 64n - 1n;
const HASH = /^[a-f0-9]{64}$/;
const BINDING_KEYS = [
  'chain', 'chainIndex', 'fromMint', 'toMint', 'amountHuman', 'amountRaw', 'fromDecimals',
  'slippagePercent', 'recipient', 'createdAt', 'expiresAt', 'swapMode',
];
const PREVIEW_KEYS = ['schemaVersion', 'binding', 'source', 'dry_run', 'notice', 'quote', 'unsigned'];

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const hasKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

function asciiString(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, character =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}

// Python v1 uses sorted keys, ASCII escapes and integers in the portable schema.
function canonical(value) {
  if (value === null || typeof value === 'boolean' || Number.isSafeInteger(value)) {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return asciiString(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (isRecord(value)) {
    return '{' + Object.keys(value).sort().map(key => asciiString(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new Error('Unsupported JSON value');
}

function frozen(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

function validAddress(value) {
  try {
    pubkey(value);
    return true;
  } catch {
    return false;
  }
}

function brisbaneTime(value) {
  if (!matches(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+10:00$/)) return NaN;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return NaN;
  const local = new Date(time + 36_000_000).toISOString().slice(0, 19) + '+10:00';
  return value === local && !value.startsWith('0000') ? time : NaN;
}

function decimalParts(value) {
  if (!matches(value, /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/) || value.length > 80) return null;
  return value.split('.');
}

function validBinding(binding) {
  if (!hasKeys(binding, BINDING_KEYS)) return false;
  const { chain, chainIndex, swapMode, fromMint, toMint, recipient, fromDecimals } = binding;
  if (chain !== 'solana' || chainIndex !== '501' || swapMode !== 'exactIn' || fromMint === toMint
      || ![fromMint, toMint, recipient].every(validAddress)) return false;
  if (!Number.isInteger(fromDecimals) || fromDecimals < 0 || fromDecimals > 18) return false;
  const amount = decimalParts(binding.amountHuman);
  const slippage = decimalParts(binding.slippagePercent);
  if (!amount || !slippage || BigInt(slippage[0]) >= 100n) return false;
  const [whole, fraction = ''] = amount;
  if (fraction.length > fromDecimals) return false;
  const raw = BigInt(whole + fraction.padEnd(fromDecimals, '0'));
  const lifetime = brisbaneTime(binding.expiresAt) - brisbaneTime(binding.createdAt);
  return raw > 0n && raw <= MAX_U64 && binding.amountRaw === String(raw)
    && lifetime >= 1000 && lifetime <= 600_000;
}

function validRaw(value) {
  return matches(value, /^[1-9]\d{0,19}$/) && BigInt(value) <= MAX_U64;
}

function validQuote(quote, binding) {
  return isRecord(quote) && quote.chainIndex === binding.chainIndex
    && (!Object.hasOwn(quote, 'swapMode') || quote.swapMode === binding.swapMode)
    && quote.fromTokenAmount === binding.amountRaw && validRaw(quote.toTokenAmount)
    && quote.fromToken?.tokenContractAddress === binding.fromMint
    && quote.fromToken.decimal === String(binding.fromDecimals)
    && quote.toToken?.tokenContractAddress === binding.toMint
    && matches(quote.toToken.decimal, /^(0|[1-9]\d{0,2})$/) && Number(quote.toToken.decimal) <= 255
    && (quote.priceImpactPercent === null
      || (matches(quote.priceImpactPercent, /^-?\d+(?:\.\d+)?$/) && quote.priceImpactPercent.length <= 80));
}

function validDexQuote(quote, binding) {
  return hasKeys(quote, ['chainIndex', 'fromTokenAmount', 'toTokenAmount', 'fromToken', 'toToken',
    'priceImpactPercent', 'swapMode'])
    && [quote.fromToken, quote.toToken].every(token => hasKeys(token, ['decimal', 'tokenContractAddress']))
    && validQuote(quote, binding);
}

function validUnsigned(unsigned, quote, binding, fixture = false) {
  const fields = ['request', 'routerResult', 'tx'];
  if (!fixture && isRecord(unsigned) && Object.hasOwn(unsigned, 'instructionReview')) fields.push('instructionReview');
  if (!hasKeys(unsigned, fields)) return false;
  const { request, routerResult, tx } = unsigned;
  const expectedRequest = {
    chainIndex: binding.chainIndex, amount: binding.amountRaw, fromTokenAddress: binding.fromMint,
    toTokenAddress: binding.toMint, swapMode: binding.swapMode, slippagePercent: binding.slippagePercent,
    userWalletAddress: binding.recipient, swapReceiverAddress: binding.recipient,
  };
  if (canonical(request) !== canonical(expectedRequest) || !(fixture ? validQuote : validDexQuote)(routerResult, binding)
      || routerResult.toToken.decimal !== quote.toToken.decimal
      || routerResult.priceImpactPercent === null || quote.priceImpactPercent === null) return false;
  if (!hasKeys(tx, ['from', 'slippagePercent', 'minReceiveAmount', 'data']) || tx.from !== binding.recipient
      || tx.slippagePercent !== binding.slippagePercent || !validRaw(tx.minReceiveAmount)) return false;
  if (fixture) {
    if (!matches(tx.data, /^FIXTURE_/) || canonical(routerResult) !== canonical(quote)) return false;
  } else unsignedPacket(tx.data);
  const [whole, fraction = ''] = decimalParts(binding.slippagePercent);
  const scale = 10n ** BigInt(fraction.length);
  const basis = 100n * scale;
  const maxSlippage = BigInt(whole + fraction);
  const estimate = BigInt(routerResult.toTokenAmount);
  const minimum = BigInt(tx.minReceiveAmount);
  const bound = estimate * (basis - maxSlippage) / basis;
  return fixture ? minimum === bound : minimum >= bound && minimum <= estimate;
}

// Only inspectPreview can issue an approved selection. Return a fresh copy to the SDK bridge.
export function reviewedTransactionBytes(selection) {
  const data = reviewedWires.get(selection);
  return data ? unsignedPacket(data) : null;
}

export async function inspectPreview(text, pinnedHash, now) {
  const time = () => now === undefined ? Date.now() : now;
  const rejected = status => Object.freeze({ status, canConnect: false });
  if (!matches(pinnedHash, HASH)) return rejected('hash_required');
  if (typeof text !== 'string' || text.length > 250_000) return rejected('invalid');

  try {
    const { preview, sha256, canonical_json } = JSON.parse(text);
    if (!isRecord(preview)) return rejected('invalid');
    const serialized = canonical(preview);
    if (serialized !== canonical_json || sha256 !== pinnedHash) return rejected('hash_mismatch');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
    const computed = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (computed !== pinnedHash) return rejected('hash_mismatch');
    if (!hasKeys(preview, PREVIEW_KEYS) || preview.schemaVersion !== 1
        || typeof preview.notice !== 'string' || !validBinding(preview.binding)) return rejected('invalid');
    const { binding, source, dry_run, quote, unsigned } = preview;
    const createdAt = brisbaneTime(binding.createdAt);
    const expiresAt = brisbaneTime(binding.expiresAt);
    const state = (status, semantics = null) => {
      const instant = time();
      const active = createdAt <= instant && instant < expiresAt;
      const canConnect = status === 'unsigned_reviewed' && active;
      const result = frozen({
        status: instant >= expiresAt ? 'expired' : instant < createdAt ? 'clock' : status,
        canConnect, payload: preview, sha256, createdAt, expiresAt, semantics,
      });
      if (canConnect) reviewedWires.set(result, unsigned.tx.data);
      return result;
    };
    if (!Number.isFinite(time()) || time() < createdAt) return rejected('clock');
    if (source === 'dry_run' && dry_run === true && quote === null && unsigned === null) return state('dry_run');
    if (source === 'fixture' && dry_run === true && validQuote(quote, binding)
        && (unsigned === null || validUnsigned(unsigned, quote, binding, true))) return state('fixture');
    if (source !== 'okx_dex_api' || dry_run !== false || preview.notice !== DEX_NOTICE || !validDexQuote(quote, binding)) return rejected('invalid');
    if (serialized.includes('FIXTURE_')) return rejected('fixture_material');
    if (unsigned === null) return state('quote_only');
    if (!validUnsigned(unsigned, quote, binding)) return rejected('invalid');
    const semantics = await reviewSemantics(preview, time());
    if (semantics.status === 'passed') return state('unsigned_reviewed', semantics);
    const status = semantics.reasons[0] === 'missing_instruction_review' ? 'unsigned_unreviewed' : 'unsigned_rejected';
    return state(status, semantics);
  } catch {
    return rejected('invalid');
  }
}
