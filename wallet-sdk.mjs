// This bridge is bundled for Pages and loaded only inside the explicit connect handler.
import { VersionedTransaction } from '@solana/web3.js';

export { OKXUniversalProvider } from '@okxconnect/universal-provider';
export { OKXSolanaProvider } from '@okxconnect/solana-provider';

export function toWalletTransaction(wire) {
  // This SDK type supports both message formats and preserves compiled legacy account order.
  const transaction = VersionedTransaction.deserialize(wire);
  const serialized = transaction.serialize();
  if (serialized.length !== wire.length || !serialized.every((byte, i) => byte === wire[i])) {
    throw new Error('Wallet transaction differs from reviewed bytes');
  }
  return transaction;
}
