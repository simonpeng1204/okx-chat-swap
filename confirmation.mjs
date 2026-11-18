const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
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

function base58Bytes(value) {
  let number = 0n;
  for (const character of value) number = number * 58n + BigInt(BASE58.indexOf(character));
  const leading = value.length - value.replace(/^1+/, '').length;
  const hex = number ? number.toString(16) : '';
  const byteCount = Math.ceil(hex.length / 2);
  const padded = hex.padStart(byteCount * 2, '0');
  const bytes = new Uint8Array(leading + byteCount);
  for (let index = 0; index < byteCount; index++) {
    bytes[leading + index] = Number.parseInt(padded.slice(2 * index, 2 * index + 2), 16);
  }
  return bytes;
}

function validAddress(value) {
  return matches(value, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/) && base58Bytes(value).length === 32;
}

function unsignedPacket(value) {
  if (!matches(value, /^[1-9A-HJ-NP-Za-km-z]{70,1683}$/)) return false;
  const bytes = base58Bytes(value);
  const count = bytes[0];
  const start = 1 + 64 * count;
  if (!count || start + 3 >= bytes.length || bytes.length > 1232 || bytes.subarray(1, start).some(Boolean)) {
    return false;
  }
  return bytes[start + Number(bytes[start] === 0x80)] === count;
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

function validUnsigned(unsigned, quote, binding, fixture = false) {
  if (!hasKeys(unsigned, ['request', 'routerResult', 'tx'])) return false;
  const { request, routerResult, tx } = unsigned;
  const expectedRequest = {
    chainIndex: binding.chainIndex, amount: binding.amountRaw, fromTokenAddress: binding.fromMint,
    toTokenAddress: binding.toMint, swapMode: binding.swapMode, slippagePercent: binding.slippagePercent,
    userWalletAddress: binding.recipient, swapReceiverAddress: binding.recipient,
  };
  if (canonical(request) !== canonical(expectedRequest) || !validQuote(routerResult, binding)
      || routerResult.toToken.decimal !== quote.toToken.decimal
      || routerResult.priceImpactPercent === null || quote.priceImpactPercent === null) return false;
  if (!hasKeys(tx, ['from', 'slippagePercent', 'minReceiveAmount', 'data']) || tx.from !== binding.recipient
      || tx.slippagePercent !== binding.slippagePercent || !validRaw(tx.minReceiveAmount)) return false;
  if (fixture) {
    if (!matches(tx.data, /^FIXTURE_/) || canonical(routerResult) !== canonical(quote)) return false;
  } else if (!unsignedPacket(tx.data)) return false;
  const [whole, fraction = ''] = decimalParts(binding.slippagePercent);
  const scale = 10n ** BigInt(fraction.length);
  const basis = 100n * scale;
  const maxSlippage = BigInt(whole + fraction);
  const estimate = BigInt(routerResult.toTokenAmount);
  const minimum = BigInt(tx.minReceiveAmount);
  const bound = estimate * (basis - maxSlippage) / basis;
  return fixture ? minimum === bound : minimum >= bound && minimum <= estimate;
}

export async function inspectPreview(text, pinnedHash, now = Date.now()) {
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
    const state = (status, canConnect = false) => frozen({
      status: now >= expiresAt ? 'expired' : status,
      canConnect: canConnect && now < expiresAt, payload: preview, sha256, createdAt, expiresAt,
    });
    if (!Number.isFinite(now) || now < createdAt) return rejected('clock');
    if (source === 'dry_run' && dry_run === true && quote === null && unsigned === null) return state('dry_run');
    if (source === 'fixture' && dry_run === true && validQuote(quote, binding)
        && (unsigned === null || validUnsigned(unsigned, quote, binding, true))) return state('fixture');
    if (source !== 'okx_dex_api' || dry_run !== false || !validQuote(quote, binding)) return rejected('invalid');
    if (serialized.includes('FIXTURE_')) return rejected('fixture_material');
    if (unsigned === null) return state('quote_only');
    if (!validUnsigned(unsigned, quote, binding)) return rejected('invalid');
    return state('unsigned_unreviewed', true);
  } catch {
    return rejected('invalid');
  }
}
