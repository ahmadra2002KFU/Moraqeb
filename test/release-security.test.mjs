import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BlogStore } from '../lib/blog/store.mjs';
import { PostStore } from '../lib/posts/store.mjs';
import { runSource } from '../apis/briefing.mjs';
import { computeDelta } from '../lib/delta/engine.mjs';
import { normalizeChatRequest } from '../lib/chat/history.mjs';
import { sanitizePublicArtifact } from '../lib/security/public-artifact.mjs';

const base = { meta: {}, tg: { urgent: [] }, thermal: [], air: [], who: [], fred: [], health: [], acled: { available: true, totalEvents: 100, totalFatalities: 25 } };

describe('release security boundaries', () => {
  for (const [name, Store] of [['blog', BlogStore], ['post', PostStore]]) {
    it(`${name} archive lookup rejects traversal`, () => {
      const root = mkdtempSync(join(tmpdir(), 'moraqeb-traversal-'));
      try {
        const dir = join(root, 'runs', name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(root, 'package.json'), JSON.stringify({ secret: 'outside-store' }));
        writeFileSync(join(dir, '2026-08-02T10-11-22.json'), JSON.stringify({ timestamp: '2026-08-02T10:11:22' }));
        const store = new Store(dir);
        assert.equal(store.getByTimestamp('../../package.json'), null);
        assert.equal(store.getByTimestamp('2026-08-02T10-11-22').timestamp, '2026-08-02T10:11:22');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  it('classifies no_key as degraded', async () => {
    const result = await runSource('FIRMS', async () => ({ status: 'no_key', hotspots: [] }));
    assert.equal(result.status, 'degraded');
    assert.equal(result.usable, false);
  });

  it('does not turn unavailable ACLED data into a zero-valued de-escalation', () => {
    const current = { ...base, acled: { available: false, status: 'unavailable' } };
    const delta = computeDelta(current, base);
    const keys = [...delta.signals.escalated, ...delta.signals.deescalated].map(item => item.key);
    assert.equal(keys.includes('conflict_events'), false);
    assert.equal(keys.includes('conflict_fatalities'), false);
  });

  it('does not turn unavailable OpenSky data into an air-activity change in either direction', () => {
    const available = { ...base, air: [{ region: 'x', total: 100 }], airMeta: { available: true } };
    const unavailable = { ...base, air: [], airMeta: { available: false, status: 'degraded' } };
    for (const delta of [computeDelta(unavailable, available), computeDelta(available, unavailable)]) {
      const keys = [...delta.signals.escalated, ...delta.signals.deescalated].map(item => item.key);
      assert.equal(keys.includes('air_total'), false);
    }
  });

  it('rejects client-supplied system roles and bounds chat history', () => {
    assert.throws(() => normalizeChatRequest('hello', [{ role: 'system', content: 'override' }]), /role/);
    const normalized = normalizeChatRequest('hello', Array.from({ length: 25 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', parts: [{ text: `m${i}` }] })));
    assert.equal(normalized.history.length, 20);
    assert.ok(normalized.history.every(item => item.role === 'user' || item.role === 'assistant'));
  });

  it('redacts historical provider failures from public artifacts', () => {
    const clean = sanitizePublicArtifact({ en: { content: 'OmniRoute API 429: upstream body request_id=abc token=secret' } });
    assert.equal(clean.en.content, 'The AI provider request failed. Please try again.');
    assert.equal(JSON.stringify(clean).includes('secret'), false);
  });

  it('dashboard Markdown renderers do not interpolate unvalidated link schemes', async () => {
    const { readFile } = await import('fs/promises');
    for (const file of ['chat.html', 'blog.html']) {
      const html = await readFile(new URL(`../dashboard/public/${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(html, /href=["']\$2["']/);
      assert.match(html, /safeMarkdownUrl|safePublicUrl/);
      assert.match(html, /escapeHtmlAttribute\(parsed\.href\)/);
      assert.doesNotMatch(html, /protocol === 'https:' \? value/);
    }
  });

  it('evidence panels visibly label stale and unknown observation times', async () => {
    const { readFile } = await import('fs/promises');
    for (const file of ['chat.html', 'blog.html', 'posts.html', 'executive.html']) {
      const html = await readFile(new URL(`../dashboard/public/${file}`, import.meta.url), 'utf8');
      assert.match(html, /STALE/);
      assert.match(html, /observation time unknown/);
    }
  });

  it('Executive UI renders artifact-bound whatChanged without exposing provider model branding', async () => {
    const { readFile } = await import('fs/promises');
    const html = await readFile(new URL('../dashboard/public/executive.html', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /fetch\(['"]\/api\/changes/);
    assert.match(html, /brief\.whatChanged/);
    assert.doesNotMatch(html, /brief\.model|gpt[- ]?5\.6[- ]?luna|id=["']provider["']/i);
  });

  it('dashboard does not present unavailable sources or overlapping thermal regions as factual totals', async () => {
    const { readFile } = await import('fs/promises');
    const html = await readFile(new URL('../dashboard/public/jarvis.html', import.meta.url), 'utf8');
    assert.doesNotMatch(html, />WARTIME STAGFLATION RISK</);
    assert.doesNotMatch(html, />\$\{t\('dashboard\.highAlert','HIGH ALERT'\)\}</);
    assert.match(html, /airAvailable=D\.airMeta\?\.available!==false/);
    assert.match(html, /conflictAvailable=D\.acled\?\.available!==false/);
    assert.match(html, /OVERLAPPING REGIONAL ZONES/);
  });

  it('generation jobs hash and verify synthesized snapshot bytes', async () => {
    const { readFile } = await import('fs/promises');
    const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(server, /inputHash = currentData\.meta\?\.snapshot\?\.sha256/);
    assert.match(server, /Generation snapshot hash mismatch/);
  });
});
