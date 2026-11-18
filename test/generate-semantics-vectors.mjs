// Explicitly synthetic public keys and blockhash. This script creates no keys or signatures.
// Regenerate from web with: node test/generate-semantics-vectors.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { AddressLookupTableAccount, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage,
  VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

const key = byte => new PublicKey(Buffer.alloc(32, byte));
const user = key(5), peer = key(6), from = key(7), to = key(8), tableKey = key(9);
const system = new PublicKey('11111111111111111111111111111111');
const token = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const token22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ata = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const budget = new PublicKey('ComputeBudget111111111111111111111111111111');
const account = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const associated = (owner, mint) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), token.toBuffer(), mint.toBuffer()], ata)[0];
const create = (owner, mint, address = associated(owner, mint)) => new TransactionInstruction({
  programId: ata, data: Buffer.of(1),
  keys: [account(peer, true, true), account(address, true), account(owner), account(mint),
    account(system), account(token)],
});
const transfer = (owner, mint, receiver, amount, decimals) => {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;
  return new TransactionInstruction({ programId: token, data, keys: [
    account(associated(owner, mint), true), account(mint), account(associated(receiver, mint), true),
    account(owner, false, true),
  ] });
};

const input = () => transfer(user, from, peer, 125_000_000n, 9);
const output = () => transfer(peer, to, user, 4_179_000n, 6);
const standard = () => [create(user, from), create(user, to), input(), output()];
const tableAddresses = [key(19), associated(user, from), associated(peer, from), associated(peer, to),
  associated(user, to), from, to];
const lookup = (key, addresses) => new AddressLookupTableAccount({
  key, state: { addresses, deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0,
    lastExtendedSlotStartIndex: 0 },
});
const table = lookup(tableKey, tableAddresses);
function encoded(instructions, tables = [], payerKey = user) {
  const message = new TransactionMessage({ payerKey, recentBlockhash: key(17).toBase58(), instructions });
  const compiled = tables.length ? message.compileToV0Message(tables) : message.compileToLegacyMessage();
  const packet = new VersionedTransaction(compiled).serialize();
  return {
    data: bs58.encode(packet),
    instructionReview: {
      addressLookupTableAccount: tables.map(entry => String(entry.key)),
      addressLookupTableContents: Object.fromEntries(tables.map(entry => [entry.key, entry.state.addresses.map(String)])),
      instructionLists: instructions.map(({ programId, data, keys }) => ({
        programId: String(programId), data: data.toString('base64'),
        accounts: keys.map(({ pubkey, isWritable, isSigner }) => ({ pubkey: String(pubkey), isWritable, isSigner })),
      })),
    },
  };
}

const { fixture } = JSON.parse(readFileSync(new URL('./python-envelopes.json', import.meta.url)));
const base = fixture.preview;
Object.assign(base, { source: 'okx_dex_api', dry_run: false,
  notice: 'OKX DEX API 报价材料。未签名交易须通过链上指令语义审查。' });
Object.assign(base.binding, { fromMint: String(from), toMint: String(to), recipient: String(user) });
for (const q of [base.quote, base.unsigned.routerResult]) {
  for (const field of ['estimateGasFee', 'tradeFee', 'dexRouterList']) delete q[field];
  q.fromToken = { tokenContractAddress: String(from), decimal: '9' };
  q.toToken = { tokenContractAddress: String(to), decimal: '6' };
}
Object.assign(base.unsigned.request, { fromTokenAddress: String(from), toTokenAddress: String(to),
  userWalletAddress: String(user), swapReceiverAddress: String(user) });
base.unsigned.tx.from = String(user);

const vectors = {};
function add(name, packet, reason = null, extra = {}) {
  vectors[name] = { ...packet, reason, ...extra };
}
const legacy = encoded(standard());
const versioned = encoded(standard(), [table]);
add('legacy_exact_in', legacy);
add('v0_writable_and_readonly', versioned);
add('v0_multiple_tables', encoded(standard(), [
  lookup(tableKey, [...tableAddresses.slice(0, 3), from]), lookup(key(10), [...tableAddresses.slice(3, 5), to]),
]));
add('wrong_fee_payer', encoded(standard(), [], peer), 'fee_payer_mismatch');
const withBudget = standard();
const limit = new TransactionInstruction({ programId: budget, data: Buffer.of(2, 0x40, 0x0d, 3, 0), keys: [] });
withBudget.unshift(limit);
add('compute_unit_limit', encoded(withBudget));
add('duplicate_compute_unit_limit', encoded([limit, ...withBudget]), 'duplicate_compute_budget');
const price = new TransactionInstruction({ programId: budget, data: Buffer.of(3, 1, 0, 0, 0, 0, 0, 0, 0), keys: [] });
add('compute_priority_fee_unbound', encoded([price, ...standard()]), 'unbound_priority_fee');

for (const [name, change] of Object.entries({
  amount: ix => ix[2].data.writeBigUInt64LE(125_000_001n, 1),
  mint: ix => { ix[2].keys[1].pubkey = to; },
  source: ix => { ix[2].keys[0].pubkey = associated(peer, from); },
  destination: ix => { ix[3].keys[2].pubkey = associated(peer, to); },
  minimum: ix => ix[3].data.writeBigUInt64LE(4_178_999n, 1),
  decimals: ix => { ix[2].data[9] = 8; },
})) {
  const ix = standard();
  change(ix);
  add('resealed_' + name, encoded(ix), 'swap_effect_mismatch');
}

const falseAta = standard();
falseAta[1] = create(user, to, key(18));
falseAta[3].keys[2].pubkey = key(18);
add('coordinated_false_ata', encoded(falseAta), 'invalid_ata');
add('other_ata_owner', encoded([create(peer, from), ...standard()]), 'unbound_ata_owner');
const unknown = standard();
unknown[2].programId = new PublicKey('proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u');
add('unknown_router', encoded(unknown), 'unimplemented_program:' + unknown[2].programId);
const short = standard();
short[2].data = Buffer.of(12);
add('short_instruction', encoded(short), 'invalid_instruction');
const missingAuthority = standard();
missingAuthority[2].keys.pop();
add('missing_instruction_account', encoded(missingAuthority), 'invalid_instruction');
const tokenExtensions = standard();
tokenExtensions[2].programId = token22;
add('token_2022_requires_state', encoded(tokenExtensions), 'unverified_token_extensions');
const approval = standard();
approval[2].data = Buffer.of(4, 1, 0, 0, 0, 0, 0, 0, 0);
approval[2].keys.splice(1, 1);
add('unbound_approval', encoded(approval), 'unbound_spender');
const unchecked = standard();
unchecked[2].data = unchecked[2].data.subarray(0, 9);
unchecked[2].data[0] = 3;
unchecked[2].keys.splice(1, 1);
add('unchecked_transfer', encoded(unchecked), 'unbound_token_effect');
const close = new TransactionInstruction({ programId: token, data: Buffer.of(9), keys: [
  account(associated(user, from), true), account(user, true), account(user, false, true),
] });
add('unbound_close_account', encoded([...standard(), close]), 'unbound_token_effect');
const sync = new TransactionInstruction({ programId: token, data: Buffer.of(17),
  keys: [account(associated(user, from), true)] });
add('unbound_sync_native', encoded([sync, ...standard()]), 'unbound_token_effect');
add('wrong_system_transfer_target', encoded([SystemProgram.transfer({
  fromPubkey: user, toPubkey: peer, lamports: 125_000_000,
}), ...standard()]), 'system_effect_mismatch');
add('unbound_system_create', encoded([SystemProgram.createAccount({
  fromPubkey: user, newAccountPubkey: key(18), lamports: 1, space: 165, programId: token,
}), ...standard()]), 'unbound_account_creation');

function reviewPatch(packet, mutate) {
  const copy = structuredClone(packet);
  mutate(copy.instructionReview);
  return copy;
}
add('missing_alt_contents', reviewPatch(versioned, review => { review.addressLookupTableContents = {}; }),
  'missing_lookup_table:' + tableKey);
add('lookup_index_out_of_bounds', reviewPatch(versioned, review => {
  review.addressLookupTableContents[tableKey].pop();
}), 'lookup_index_out_of_bounds');
add('instruction_account_mismatch', reviewPatch(legacy, review => {
  review.instructionLists[2].accounts[0].pubkey = String(key(19));
}), 'instruction_mismatch');
add('instruction_data_mismatch', reviewPatch(legacy, review => {
  review.instructionLists[2].data = 'DAA=';
}), 'instruction_mismatch');
add('instruction_program_mismatch', reviewPatch(legacy, review => {
  review.instructionLists[2].programId = String(token22);
}), 'instruction_mismatch');
add('instruction_privilege_mismatch', reviewPatch(legacy, review => {
  review.instructionLists[2].accounts[1].isWritable = true;
}), 'instruction_mismatch');
add('old_preview', { ...legacy, instructionReview: null }, 'missing_instruction_review');
add('fixture_sentinel', { ...legacy, data: 'FIXTURE_UNSIGNED' }, 'invalid_transaction');
add('undecodable', { ...legacy, data: '2'.repeat(160) }, 'invalid_transaction');
const signedSlot = bs58.decode(legacy.data);
signedSlot[1] = 1;
add('nonempty_signature', { ...legacy, data: bs58.encode(signedSlot) }, 'invalid_transaction');
add('trailing_bytes', { ...legacy, data: bs58.encode(Buffer.concat([bs58.decode(legacy.data), Buffer.of(0)])) },
  'invalid_transaction');
add('noncanonical_shortvec', {
  ...legacy, data: bs58.encode(Buffer.concat([Buffer.of(0x82, 0), bs58.decode(legacy.data).slice(1)])),
}, 'invalid_transaction');
add('expired', legacy, 'expired_preview', { elapsed: 120 });
add('fixture_provenance', legacy, null, { source: 'fixture' });
add('dry_run_provenance', legacy, null, { source: 'dry_run' });

writeFileSync(new URL('./semantics-vectors.json', import.meta.url),
  JSON.stringify({ notice: 'SYNTHETIC offline test vectors generated using Solana web3.js, no signatures',
    base, vectors }, null, 2) + '\n');
