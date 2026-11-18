import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const { base, vectors } = JSON.parse(readFileSync(new URL('./semantics-vectors.json', import.meta.url)));
export const canonical = value => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => canonical(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
};
export function vectorPreview(name) {
  const vector = vectors[name];
  const preview = structuredClone(base);
  preview.unsigned.tx.data = vector.data;
  if (vector.instructionReview !== null) preview.unsigned.instructionReview = vector.instructionReview;
  if (vector.source) Object.assign(preview, { source: vector.source, dry_run: true });
  return preview;
}
export function vectorEnvelope(name) {
  const preview = vectorPreview(name);
  const canonical_json = canonical(preview);
  return { preview, canonical_json, sha256: createHash('sha256').update(canonical_json).digest('hex') };
}

