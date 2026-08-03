import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { assertArtifactPublishable } from '../lib/generation/quality-gate.mjs';
import { BlogStore } from '../lib/blog/store.mjs';
import { PostStore } from '../lib/posts/store.mjs';
import { ExecutiveStore } from '../lib/executive/store.mjs';

const language = { evidenceStatus: 'validated', citationValidation: { valid: true, citedIds: ['E1'], unsupportedIds: [], unsupportedClaims: [], coverage: { evidenceRequired: 1, supported: 1, rate: 1 } }, evidence: [{ id: 'E1' }], content: '[OBSERVED] Valid [E1].' };
const generation = (jobId, scheduledFor) => ({ jobId, scheduledFor, promptVersion: 'evidence-v11', snapshotId: 'sweep_test_1', inputHash: 'a'.repeat(64) });
const artifact = (timestamp, jobId, en = language, ar = language) => ({
  schemaVersion: 'moraqeb.generated.v2', timestamp, generation: generation(jobId, timestamp), en: { ...en }, ar: { ...ar },
});

describe('artifact publication quality gate', () => {
  it('accepts only bilingual validated artifacts without unsupported markers', () => {
    assert.equal(assertArtifactPublishable({ en: language, ar: language }), true);
    assert.throws(() => assertArtifactPublishable({ en: language, ar: language }, 'test', { requireLineage: true }), /publication quality gate/);
    assert.throws(() => assertArtifactPublishable({ en: { ...language, evidenceStatus: 'partial' }, ar: language }), /publication quality gate/);
    assert.throws(() => assertArtifactPublishable({ en: language, ar: { ...language, content: '[UNSUPPORTED] claim' } }), /publication quality gate/);
  });

  for (const [name, Store] of [['blog', BlogStore], ['post', PostStore], ['executive', ExecutiveStore]]) {
    it(`${name} archives rejected output but does not replace latest`, () => {
      const dir = mkdtempSync(join(tmpdir(), `moraqeb-gate-${name}-`));
      try {
        const store = new Store(dir);
        const valid = artifact('2026-08-02T12:00:00.000Z', `${name}:valid`);
        store.save(valid);
        const before = readFileSync(join(dir, 'latest.json'), 'utf8');
        const partial = artifact('2026-08-02T12:01:00.000Z', `${name}:partial`, { ...language, evidenceStatus: 'partial' });
        assert.throws(() => store.save(partial), /publication quality gate/);
        assert.equal(readFileSync(join(dir, 'latest.json'), 'utf8'), before);
        const rejectedArchive = readdirSync(dir).find(file => file.startsWith('2026-08-02T12-01-00.000Z--evidence-v11--'));
        assert.ok(rejectedArchive);
        assert.equal(store.getArchive().some(item => item.filename === rejectedArchive), false);
        if (typeof store.getByTimestamp === 'function') assert.equal(store.getByTimestamp(rejectedArchive), null);

        const missingLineage = artifact('2026-08-02T12:02:00.000Z', `${name}:missing-lineage`);
        delete missingLineage.generation.snapshotId;
        assert.throws(() => store.save(missingLineage), /publication quality gate/);
        const lineageArchive = readdirSync(dir).find(file => file.startsWith('2026-08-02T12-02-00.000Z--evidence-v11--'));
        assert.ok(lineageArchive);
        assert.equal(store.getArchive().some(item => item.filename === lineageArchive), false);
        if (typeof store.getByTimestamp === 'function') assert.equal(store.getByTimestamp(lineageArchive), null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`${name} archives an older valid retry without rolling latest backward`, () => {
      const dir = mkdtempSync(join(tmpdir(), `moraqeb-order-${name}-`));
      try {
        const store = new Store(dir);
        const newer = artifact('2026-08-02T12:10:00.000Z', `${name}:newer`);
        const older = artifact('2026-08-02T12:05:00.000Z', `${name}:older`);
        store.save(newer);
        const before = readFileSync(join(dir, 'latest.json'), 'utf8');
        assert.throws(() => store.save(older), /not newer than current latest/);
        assert.equal(readFileSync(join(dir, 'latest.json'), 'utf8'), before);
        assert.equal(readdirSync(dir).some(file => file.startsWith('2026-08-02T12-05-00.000Z--evidence-v11--')), true);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it(`${name} permits a newer prompt version at the same scheduled boundary`, () => {
      const dir = mkdtempSync(join(tmpdir(), `moraqeb-upgrade-${name}-`));
      try {
        const store = new Store(dir);
        const oldVersion = artifact('2026-08-02T12:10:00.000Z', `${name}:v11`);
        const newVersion = artifact('2026-08-02T12:10:00.000Z', `${name}:v12`);
        oldVersion.generation.promptVersion = 'evidence-v11';
        newVersion.generation.promptVersion = 'evidence-v12';
        store.save(oldVersion);
        const oldArchive = readdirSync(dir).find(file => file.includes('--evidence-v11--'));
        const oldBytes = readFileSync(join(dir, oldArchive), 'utf8');
        store.save(newVersion);
        assert.equal(store.getLatest().generation.promptVersion, 'evidence-v12');
        assert.equal(readFileSync(join(dir, oldArchive), 'utf8'), oldBytes);
        assert.equal(readdirSync(dir).filter(file => file !== 'latest.json').length, 2);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
