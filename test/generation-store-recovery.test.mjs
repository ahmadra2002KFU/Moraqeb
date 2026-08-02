import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BlogStore } from '../lib/blog/store.mjs';
import { PostStore } from '../lib/posts/store.mjs';
import { ExecutiveStore } from '../lib/executive/store.mjs';

describe('generation artifact recovery', () => {
  for (const [name, Store] of [['blog', BlogStore], ['post', PostStore], ['executive', ExecutiveStore]]) {
    it(`${name} finds the archive by generation ID when latest is missing`, () => {
      const dir = mkdtempSync(join(tmpdir(), `moraqeb-${name}-`));
      try {
        const store = new Store(dir);
        const artifact = { timestamp: '2026-08-02T12:00:00.123Z', generatedAt: '2026-08-02T12:00:01Z', generationJobId: `${name}:job`, generation: { jobId: `${name}:job` }, en: { evidenceStatus: 'partial', evidence: [] }, ar: { evidenceStatus: 'validated', evidence: [] } };
        store.save(artifact);
        if (name !== 'executive') assert.equal(store.getArchive(1)[0].en.evidenceStatus, 'partial');
        unlinkSync(join(dir, 'latest.json'));
        const recovered = store.getByGenerationId(`${name}:job`);
        assert.equal(recovered.generationJobId, `${name}:job`);
        store.save(recovered);
        assert.equal(existsSync(join(dir, 'latest.json')), true);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
