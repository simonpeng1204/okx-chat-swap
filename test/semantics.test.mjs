import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectPreview } from '../confirmation.mjs';
import { vectors, vectorEnvelope } from './semantics-vectors.mjs';

const now = Date.parse('2026-11-18T12:00:00+10:00');

for (const [name, { reason, elapsed = 0, source }] of Object.entries(vectors)) {
  test('Solana wire vector ' + name, async () => {
    const { reviewSemantics } = await import('../semantics.mjs');
    const instant = now + elapsed * 1000;
    const envelope = vectorEnvelope(name);
    const audit = await reviewSemantics(envelope.preview, instant);
    assert.equal(audit.status, reason === null ? 'passed' : 'rejected');
    assert.deepEqual(audit.reasons, reason === null ? [] : [reason]);
    if (reason === null) assert.ok(audit.notes.includes('blockhash_freshness_unverified'));
    const confirmed = await inspectPreview(JSON.stringify(envelope), envelope.sha256, instant);
    assert.equal(confirmed.canConnect, reason === null && !source);
    if (confirmed.canConnect) assert.equal(confirmed.status, 'unsigned_reviewed');
  });
}
