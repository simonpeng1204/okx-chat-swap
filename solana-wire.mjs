// Solana packet decoding is independent of the wallet SDK.
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export class WireError extends Error {}

function need(condition) {
  if (!condition) throw new WireError('Invalid Solana wire format');
}

export function decodeBase58(value, maxLength) {
  need(typeof value === 'string' && value.length > 0 && value.length <= maxLength);
  let number = 0n;
  for (const character of value) {
    const digit = BASE58.indexOf(character);
    need(digit >= 0);
    number = number * 58n + BigInt(digit);
  }
  const leading = value.length - value.replace(/^1+/, '').length;
  const hex = number ? number.toString(16) : '';
  const count = Math.ceil(hex.length / 2);
  const padded = hex.padStart(count * 2, '0');
  const bytes = new Uint8Array(leading + count);
  for (let index = 0; index < count; index++) {
    bytes[leading + index] = Number.parseInt(padded.slice(2 * index, 2 * index + 2), 16);
  }
  return bytes;
}

export function pubkey(value) {
  const bytes = decodeBase58(value, 44);
  need(bytes.length === 32);
  return bytes;
}

function encodeBase58(bytes) {
  let number = 0n;
  let leading = 0;
  for (const byte of bytes) number = number * 256n + BigInt(byte);
  while (leading < bytes.length && bytes[leading] === 0) leading++;
  let digits = '';
  while (number) {
    digits = BASE58[Number(number % 58n)] + digits;
    number /= 58n;
  }
  return '1'.repeat(leading) + digits;
}

export function unsignedPacket(value) {
  const wire = decodeBase58(value, 1683);
  need(wire.length > 0 && wire.length <= 1232);
  // Any packet-sized signature vector has a one-byte canonical length.
  const count = wire[0];
  const start = 1 + 64 * count;
  need(count > 0 && start + 3 < wire.length && !wire.subarray(1, start).some(Boolean));
  need(wire[start + Number(wire[start] === 0x80)] === count);
  return wire;
}

class Reader {
  constructor(wire) {
    this.wire = wire;
    this.cursor = 0;
  }

  take(size) {
    const end = this.cursor + size;
    need(end <= this.wire.length);
    const bytes = this.wire.subarray(this.cursor, end);
    this.cursor = end;
    return bytes;
  }

  byte() { return this.take(1)[0]; }

  length() {
    let value = 0;
    for (const shift of [0, 7, 14]) {
      const byte = this.byte();
      need(!(shift && byte === 0) && !(shift === 14 && byte > 3));
      value |= (byte & 127) << shift;
      if (byte < 128) return value;
    }
    throw new WireError('Invalid short-u16');
  }

  vector() { return this.take(this.length()); }

  key() { return encodeBase58(this.take(32)); }
}

export function decodeTransaction(value) {
  const wire = unsignedPacket(value);
  const reader = new Reader(wire);
  const signatureCount = reader.length();
  reader.take(64 * signatureCount);
  const lead = reader.byte();
  need(lead <= 128);
  const version = lead === 128 ? 'v0' : 'legacy';
  const signers = version === 'v0' ? reader.byte() : lead;
  const readonlySigners = reader.byte();
  const readonlyUnsigned = reader.byte();
  const count = reader.length();
  need(signers === signatureCount && readonlySigners < signers && signers <= count
    && count <= 256 && readonlyUnsigned <= count - signers);
  const accounts = Array.from({ length: count }, (_, index) => ({
    address: reader.key(), signer: index < signers,
    writable: index < signers ? index < signers - readonlySigners : index < count - readonlyUnsigned,
  }));
  const blockhash = reader.key();
  need(blockhash !== '1'.repeat(32));
  const instructions = Array.from({ length: reader.length() }, () => ({
    program: reader.byte(), indices: reader.vector(), data: reader.vector(),
  }));
  const lookups = version === 'v0' ? Array.from({ length: reader.length() }, () => ({
    table: reader.key(), writable: reader.vector(), readonly: reader.vector(),
  })) : [];
  const total = count + lookups.reduce((size, entry) => size + entry.writable.length + entry.readonly.length, 0);
  need(reader.cursor === wire.length && instructions.length > 0 && total <= 256
    && new Set(lookups.map(entry => entry.table)).size === lookups.length
    && lookups.every(entry => entry.writable.length || entry.readonly.length));
  for (const { program, indices } of instructions) {
    need(program > 0 && program < count && !accounts[program].signer && !accounts[program].writable
      && indices.every(index => index < total));
  }
  return { wire, version, accounts, blockhash, instructions, lookups };
}
