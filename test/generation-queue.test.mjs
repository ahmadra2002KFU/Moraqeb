import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { GenerationQueue } from '../lib/queue/generation-queue.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
function tempDir() { const dir = mkdtempSync(join(tmpdir(), 'moraqeb-queue-')); dirs.push(dir); return dir; }

describe('GenerationQueue', () => {
  it('persists jobs, deduplicates IDs, and completes work', async () => {
    const dir = tempDir();
    const seen = [];
    const queue = new GenerationQueue(dir, { post: async payload => { seen.push(payload); return { saved: true }; } }, { retryDelaysMs: [0] });
    assert.equal(queue.enqueue({ id: 'post:one', type: 'post', payload: { n: 1 } }), true);
    assert.equal(queue.enqueue({ id: 'post:one', type: 'post', payload: { n: 2 } }), false);
    await queue.processNext();
    assert.deepEqual(seen, [{ n: 1 }]);
    assert.equal(queue.getJob('post:one').status, 'completed');
    const onDisk = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    assert.equal(onDisk.jobs[0].status, 'completed');
  });

  it('retries failures and eventually succeeds', async () => {
    const dir = tempDir();
    let attempts = 0;
    const queue = new GenerationQueue(dir, { blog: async () => { attempts += 1; if (attempts === 1) throw new Error('temporary'); } }, { retryDelaysMs: [0, 0] });
    queue.enqueue({ id: 'blog:one', type: 'blog' });
    await queue.processNext();
    assert.equal(queue.getJob('blog:one').status, 'pending');
    await queue.processNext();
    assert.equal(queue.getJob('blog:one').status, 'completed');
    assert.equal(queue.getJob('blog:one').attempts, 2);
  });

  it('recovers interrupted running jobs after restart', () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, jobs: [{ id: 'executive:day', type: 'executive', status: 'running', attempts: 1, runAt: '2026-08-02T00:00:00.000Z' }] }));
    const queue = new GenerationQueue(dir, { executive: async () => {} });
    assert.equal(queue.getJob('executive:day').status, 'pending');
    assert.match(queue.getJob('executive:day').lastError, /recovered/i);
  });

  it('redacts handler error bodies from persisted queue state', async () => {
    const dir = tempDir();
    const q = new GenerationQueue(dir, { blog: async () => { throw new Error('upstream token=abc123'); } }, { retryDelaysMs: [0], maxAttempts: 1 });
    q.enqueue({ id: 'blog:redacted', type: 'blog' });
    await q.processNext();
    const persisted = readFileSync(join(dir, 'state.json'), 'utf8');
    assert.equal(persisted.includes('abc123'), false);
    assert.match(persisted, /Generation job failed/);
    assert.equal(q.supersedeFailures('blog', 'blog:new-success'), 1);
    assert.equal(q.getJob('blog:redacted').status, 'superseded');
    assert.equal(q.getStats().failed, 0);
    assert.equal(q.getStats().superseded, 1);
  });

  it('fails closed instead of overwriting corrupt persisted state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moraqeb-queue-corrupt-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'state.json'), '{not valid json');
    assert.throws(() => new GenerationQueue(dir, {}), /state is corrupt/);
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), '{not valid json');
  });
});
