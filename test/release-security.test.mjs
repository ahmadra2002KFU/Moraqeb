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
        const artifact = {
          timestamp: '2026-08-02T10:11:22',
          generatedAt: '2026-08-02T10:11:22.000Z',
          schemaVersion: 'moraqeb.generated.v2',
          en: { title: 'Validated', content: 'Validated', evidence: [{ id: 'E1' }], evidenceStatus: 'validated', citationValidation: { valid: true, citedIds: ['E1'], unsupportedClaims: [], unsupportedIds: [], coverage: { evidenceRequired: 1, supported: 1, rate: 1 } } },
          ar: { title: 'موثق', content: 'موثق', evidence: [{ id: 'E1' }], evidenceStatus: 'validated', citationValidation: { valid: true, citedIds: ['E1'], unsupportedClaims: [], unsupportedIds: [], coverage: { evidenceRequired: 1, supported: 1, rate: 1 } } },
          generation: { scheduledFor: '2026-08-02T10:11:22.000Z', promptVersion: 'evidence-v13', jobId: `${name}:test`, snapshotId: 'sweep_test', inputHash: 'a'.repeat(64) },
          snapshot: { hash: 'a'.repeat(64), timestamp: '2026-08-02T10:11:22.000Z' },
        };
        writeFileSync(join(dir, '2026-08-02T10-11-22.json'), JSON.stringify(artifact));
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

  it('Blog and Posts keep governance syntax in closed audit details and show only validated archives', async () => {
    const { readFile } = await import('fs/promises');
    for (const file of ['blog.html', 'posts.html']) {
      const html = await readFile(new URL(`../dashboard/public/${file}`, import.meta.url), 'utf8');
      assert.match(html, /function cleanReadingText/);
      assert.match(html, /replace\(\/\\\[E\\d\+\\\]\//);
      assert.match(html, /<details/);
      assert.match(html, /citationValidation/);
      assert.match(html, /\.valid === true/);
      assert.match(html, /min-(?:width|height):44px/);
      assert.match(html, /prefers-reduced-motion/);
      assert.match(html, /focus-visible/);
    }
  });

  it('uses Segoe UI for Arabic reader interfaces without loading Noto Sans Arabic', async () => {
    const { readFile } = await import('fs/promises');
    for (const file of ['executive.html', 'blog.html', 'posts.html']) {
      const html = await readFile(new URL(`../dashboard/public/${file}`, import.meta.url), 'utf8');
      assert.match(html, /Segoe UI/);
      assert.doesNotMatch(html, /Noto(?:\+|\s)Sans(?:\+|\s)Arabic/i);
      if (file !== 'executive.html') assert.match(html, /html\[dir="rtl"\][^}]*body\{font-family:'Segoe UI'/);
    }
  });

  it('dashboard does not present unavailable sources or overlapping thermal regions as factual totals', async () => {
    const { readFile } = await import('fs/promises');
    const html = await readFile(new URL('../dashboard/public/jarvis.html', import.meta.url), 'utf8');
    const injectSource = await readFile(new URL('../dashboard/inject.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(html, />WARTIME STAGFLATION RISK</);
    assert.doesNotMatch(html, />\$\{t\('dashboard\.highAlert','HIGH ALERT'\)\}</);
    assert.match(html, /airAvailable=D\.airMeta\?\.available!==false/);
    assert.match(html, /conflictAvailable=D\.acled\?\.available!==false/);
    assert.match(html, /DEDUPLICATED.*OVERLAPPING ZONES/);
    assert.doesNotMatch(html, /D\.thermal\.reduce\(\(s,t\)=>s\+t\.hc/);
    assert.match(html, /D\.thermalMeta\?\.highConfidence/);
    assert.match(injectSource, /const openSkyObservedAt\s*=\s*openSkyUsable\s*\?\s*\(data\.sources\.OpenSky\?\.observedAt/);
    assert.match(injectSource, /filter\(h\s*=>\s*!h\.error/);
    assert.doesNotMatch(injectSource, /V2\.thermal\.reduce\(\(s, t\) => s \+ t\.det/);
    assert.doesNotMatch(injectSource, /Satellite Confirms Conflict Intensity/);
    assert.match(injectSource, /thermalMeta\?\.uniqueDetections/);
  });

  it('generation jobs hash and verify synthesized snapshot bytes', async () => {
    const { readFile } = await import('fs/promises');
    const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(server, /inputHash = currentData\.meta\?\.snapshot\?\.sha256/);
    assert.match(server, /Generation snapshot hash mismatch/);
  });
});
