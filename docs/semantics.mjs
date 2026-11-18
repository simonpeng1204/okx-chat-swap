import { decodeTransaction, pubkey, WireError } from './solana-wire.mjs';

const SYSTEM = '11111111111111111111111111111111';
const NATIVE = 'So11111111111111111111111111111111111111112';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const BUDGET = 'ComputeBudget111111111111111111111111111111';
const RENT = 'SysvarRent111111111111111111111111111111111';
const PROGRAMS = new Set([SYSTEM, TOKEN, TOKEN_2022, ATA, BUDGET]);
const FIELD = 2n ** 255n - 19n;

class Rejected extends Error {}

function require(condition, reason = 'invalid_instruction') {
  if (!condition) throw new Rejected(reason);
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const equalBytes = (left, right) => left.length === right.length && left.every((byte, i) => byte === right[i]);

function resolveAccounts(message, metadata) {
  const tableIds = metadata.addressLookupTableAccount;
  const contents = metadata.addressLookupTableContents;
  require(Array.isArray(tableIds) && tableIds.length <= 256 && isRecord(contents), 'invalid_lookup_tables');
  tableIds.forEach(pubkey);
  const ids = new Set(tableIds);
  require(ids.size === tableIds.length && ids.size === message.lookups.length
    && message.lookups.every(({ table }) => ids.has(table))
    && Object.keys(contents).every(key => ids.has(key)), 'lookup_table_set_mismatch');
  const writable = [];
  const readonly = [];
  for (const entry of message.lookups) {
    require(Object.hasOwn(contents, entry.table), 'missing_lookup_table:' + entry.table);
    const addresses = contents[entry.table];
    require(Array.isArray(addresses) && addresses.length > 0 && addresses.length <= 256, 'invalid_lookup_tables');
    addresses.forEach(pubkey);
    for (const [indices, list, mutable] of [[entry.writable, writable, true], [entry.readonly, readonly, false]]) {
      for (const index of indices) {
        require(index < addresses.length, 'lookup_index_out_of_bounds');
        list.push({ address: addresses[index], signer: false, writable: mutable });
      }
    }
  }
  const accounts = [...message.accounts, ...writable, ...readonly];
  require(new Set(accounts.map(account => account.address)).size === accounts.length, 'duplicate_account');
  return accounts;
}

function crossCheck(instructions, expected, payer) {
  require(Array.isArray(expected) && expected.length === instructions.length, 'instruction_mismatch');
  const privileges = new Map([[payer, { signer: true, writable: true }]]);
  for (const [index, { program, accounts, data }] of instructions.entries()) {
    const item = expected[index];
    require(hasKeys(item, ['programId', 'accounts', 'data']) && item.programId === program
      && item.data === btoa(String.fromCharCode(...data))
      && Array.isArray(item.accounts) && item.accounts.length === accounts.length, 'instruction_mismatch');
    for (const [position, actual] of accounts.entries()) {
      const hint = item.accounts[position];
      require(hasKeys(hint, ['pubkey', 'isSigner', 'isWritable']) && hint.pubkey === actual.address
        && typeof hint.isSigner === 'boolean' && typeof hint.isWritable === 'boolean', 'instruction_mismatch');
      const previous = privileges.get(actual.address);
      privileges.set(actual.address, {
        signer: Boolean(previous?.signer || hint.isSigner), writable: Boolean(previous?.writable || hint.isWritable),
      });
    }
  }
  // API flags are per-instruction. Compiled flags are the union over the message.
  for (const { accounts } of instructions) {
    for (const account of accounts) {
      const hint = privileges.get(account.address);
      require(hint.signer === account.signer && hint.writable === account.writable, 'instruction_mismatch');
    }
  }
}

function mod(value) {
  return (value % FIELD + FIELD) % FIELD;
}

function power(base, exponent) {
  let factor = mod(base);
  let result = 1n;
  for (let remaining = exponent; remaining; remaining >>= 1n) {
    if (remaining & 1n) result = result * factor % FIELD;
    factor = factor * factor % FIELD;
  }
  return result;
}

const EDWARDS_D = mod(-121665n * power(121666n, FIELD - 2n));
const PDA_DOMAIN = new TextEncoder().encode('ProgramDerivedAddress');

function little(bytes) {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index--) value = value * 256n + BigInt(bytes[index]);
  return value;
}

async function associatedAddress(owner, mint, token) {
  // Runtime PDA derivation searches for the highest bump whose hash is off-curve.
  const seed = new Uint8Array(129 + PDA_DOMAIN.length);
  seed.set(pubkey(owner));
  seed.set(pubkey(token), 32);
  seed.set(pubkey(mint), 64);
  seed.set(pubkey(ATA), 97);
  seed.set(PDA_DOMAIN, 129);
  for (let bump = 255; bump >= 0; bump--) {
    seed[96] = bump;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', seed));
    const y = little(digest) & (2n ** 255n - 1n);
    const y2 = y * y % FIELD;
    const denominator = mod(EDWARDS_D * y2 + 1n);
    if (!denominator || power((y2 - 1n) * denominator, (FIELD - 1n) / 2n) === FIELD - 1n) return digest;
  }
  throw new Rejected('invalid_ata');
}

function roles(accounts, count, writable = [], signers = []) {
  require(accounts.length === count && writable.every(index => accounts[index].writable)
    && signers.every(index => accounts[index].signer));
  return accounts.map(account => account.address);
}

async function parseInstruction({ program, accounts, data }, binding) {
  if (program === BUDGET) {
    const sizes = new Map([[1, 5], [2, 5], [3, 9], [4, 5]]);
    const tag = data[0] ?? -1;
    require(sizes.has(tag), 'unsupported_layout:' + program + ':' + tag);
    require(!accounts.length && data.length === sizes.get(tag));
    const value = little(data.subarray(1));
    require(tag !== 3 || value === 0n, 'unbound_priority_fee');
    require(tag !== 1 || (32_768n <= value && value <= 262_144n && value % 1024n === 0n));
    require(tag !== 2 || (0n < value && value <= 1_400_000n));
    require(tag !== 4 || (0n < value && value <= 64n * 1024n * 1024n));
    return { kind: 'budget', tag };
  }
  if (program === SYSTEM) {
    require(data.length >= 4);
    const tag = Number(little(data.subarray(0, 4)));
    require(tag === 0 || tag === 2, 'unsupported_layout:' + program + ':' + tag);
    require(data.length === (tag === 0 ? 52 : 12));
    const [source, target] = roles(accounts, 2, [0, 1], tag === 0 ? [0, 1] : [0]);
    const lamports = little(data.subarray(4, 12));
    if (tag === 0) {
      const size = little(data.subarray(12, 20));
      const owner = data.subarray(20, 52);
      require(source === binding.recipient && source !== target && lamports > 0n
        && size <= 10n * 1024n * 1024n, 'system_effect_mismatch');
      require([TOKEN, TOKEN_2022].some(program => equalBytes(owner, pubkey(program))), 'unbound_account_owner');
      throw new Rejected('unbound_account_creation');
    }
    require(source === binding.recipient && target === binding.recipient
      && [SYSTEM, NATIVE].includes(binding.fromMint)
      && lamports === BigInt(binding.amountRaw), 'system_effect_mismatch');
    throw new Rejected('unbound_system_transfer');
  }
  if (program === ATA) {
    const tag = data[0] ?? 0;
    require(tag === 0 || tag === 1, 'unsupported_layout:' + program + ':' + tag);
    require(data.length <= 1 && (accounts.length === 6 || (accounts.length === 7
      && accounts[6].address === RENT && !accounts[6].writable && !accounts[6].signer)));
    const [payer, address, owner, mint, system, token] = roles(accounts.slice(0, 6), 6, [0, 1], [0]);
    require(system === SYSTEM && [TOKEN, TOKEN_2022].includes(token));
    require(owner === binding.recipient, 'unbound_ata_owner');
    require([binding.fromMint, binding.toMint].includes(mint), 'unbound_ata_mint');
    require(equalBytes(pubkey(address), await associatedAddress(owner, mint, token)), 'invalid_ata');
    return { kind: 'ata', payer, address, owner, mint, token, tag };
  }

  const tag = data[0] ?? -1;
  const sizes = new Map([[3, 9], [4, 9], [9, 1], [12, 10], [17, 1]]);
  require(sizes.has(tag), 'unsupported_layout:' + program + ':' + tag);
  require(data.length === sizes.get(tag));
  if (tag === 12) {
    const [source, mint, destination, authority] = roles(accounts, 4, [0, 2], [3]);
    require(program === TOKEN, 'unverified_token_extensions');
    return { kind: 'transfer_checked', source, mint, destination, authority,
      amount: little(data.subarray(1, 9)), decimals: data[9] };
  }
  if (tag === 3) {
    roles(accounts, 3, [0, 1], [2]);
    require(little(data.subarray(1)) > 0n);
  } else if (tag === 4) {
    roles(accounts, 3, [0], [2]);
    require(little(data.subarray(1)) > 0n);
    throw new Rejected('unbound_spender');
  } else if (tag === 9) {
    const [, destination, authority] = roles(accounts, 3, [0, 1], [2]);
    require(destination === authority && authority === binding.recipient, 'unbound_token_effect');
  } else {
    roles(accounts, 1, [0]);
  }
  throw new Rejected('unbound_token_effect');
}

async function reviewSwap(effects, accounts, binding, unsigned) {
  const tags = effects.filter(effect => effect.kind === 'budget').map(effect => effect.tag);
  require(new Set(tags).size === tags.length, 'duplicate_compute_budget');
  const route = effects.filter(effect => effect.kind !== 'budget');
  require(route.map(effect => effect.kind).join(',') === 'ata,ata,transfer_checked,transfer_checked',
    'unsupported_swap_layout');
  const [firstAta, secondAta, input, output] = route;
  const user = binding.recipient;
  const peer = output.authority;
  const signers = accounts.filter(account => account.signer).map(account => account.address);
  require(signers.length === 2 && signers[0] === user && signers[1] === peer && user !== peer
    && input.authority === user && input.mint === binding.fromMint && output.mint === binding.toMint
    && input.amount === BigInt(binding.amountRaw) && input.decimals === binding.fromDecimals
    && output.decimals === Number(unsigned.routerResult.toToken.decimal)
    && new Set([input.source, input.destination, output.source, output.destination]).size === 4,
  'swap_effect_mismatch');
  const atas = [firstAta, secondAta];
  require(atas.every(ata => ata.payer === peer && ata.owner === user && ata.token === TOKEN && ata.tag === 1)
    && atas.some(ata => ata.address === input.source && ata.mint === input.mint)
    && atas.some(ata => ata.address === output.destination && ata.mint === output.mint)
    && equalBytes(pubkey(input.destination), await associatedAddress(peer, input.mint, TOKEN))
    && equalBytes(pubkey(output.source), await associatedAddress(peer, output.mint, TOKEN)), 'swap_effect_mismatch');
  const estimate = BigInt(unsigned.routerResult.toTokenAmount);
  const minimum = BigInt(unsigned.tx.minReceiveAmount);
  const [whole, fraction = ''] = binding.slippagePercent.split('.');
  const numerator = BigInt(whole + fraction);
  const denominator = 100n * 10n ** BigInt(fraction.length);
  const floor = (estimate * (denominator - numerator) + denominator - 1n) / denominator;
  require(0n < floor && floor <= minimum && minimum <= estimate && output.amount >= minimum, 'swap_effect_mismatch');
}

export async function reviewSemantics(payload, now = Date.now()) {
  const notes = ['blockhash_freshness_unverified'];
  try {
    const { binding, unsigned } = payload;
    require(Number.isFinite(now) && now >= Date.parse(binding.createdAt), 'preview_clock_invalid');
    require(now < Date.parse(binding.expiresAt), 'expired_preview');
    require(binding.swapMode === 'exactIn', 'unsupported_swap_mode');
    let message;
    try {
      message = decodeTransaction(unsigned.tx.data);
    } catch (error) {
      if (error instanceof WireError) throw new Rejected('invalid_transaction');
      throw error;
    }
    if (message.lookups.length) notes.push('lookup_table_state_unverified');
    for (const { program: index } of message.instructions) {
      const program = message.accounts[index].address;
      require(PROGRAMS.has(program), 'unimplemented_program:' + program);
    }
    const metadata = unsigned.instructionReview;
    require(metadata != null, 'missing_instruction_review');
    require(hasKeys(metadata, ['addressLookupTableAccount', 'addressLookupTableContents', 'instructionLists']),
      'invalid_instruction_review');
    const accounts = resolveAccounts(message, metadata);
    require(accounts[0].address === binding.recipient, 'fee_payer_mismatch');
    const instructions = message.instructions.map(({ program, indices, data }) => ({
      program: accounts[program].address, accounts: Array.from(indices, index => accounts[index]), data,
    }));
    crossCheck(instructions, metadata.instructionLists, accounts[0].address);
    const effects = [];
    for (const instruction of instructions) effects.push(await parseInstruction(instruction, binding));
    await reviewSwap(effects, accounts, binding, unsigned);
  } catch (error) {
    return { status: 'rejected', reasons: [error instanceof Rejected ? error.message : 'invalid_semantics_input'], notes };
  }
  return { status: 'passed', reasons: [], notes };
}
