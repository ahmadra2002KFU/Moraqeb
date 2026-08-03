// Moraqeb Post Storage
// Short-form intelligence updates — JSON file storage with atomic writes, 24h pruning, and dedup support
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { assertArtifactPublishable, assertCandidateNotOlder, immutableArchiveFilename, isArtifactPublishable } from '../generation/quality-gate.mjs';

const LOG = '[Moraqeb PostStore]';
const PRUNE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Similarity Helpers ─────────────────────────────────────────────────────

/** Tokenize text for similarity comparison (borrows normalization from delta/engine.mjs contentHash). */
function tokenize(text) {
  if (!text) return new Set();
  return new Set(
    text
      .toLowerCase()
      .replace(/\d{1,2}:\d{2}(:\d{2})?/g, '')   // strip times
      .replace(/[^\w\s]/g, '')                     // strip punctuation
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(w => w.length > 2)                   // skip tiny words
  );
}

/** Jaccard similarity between two Sets: |A∩B| / |A∪B| */
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) { if (setB.has(w)) intersection++; }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export class PostStore {
  constructor(postsDir) {
    this.dir = postsDir;
    this._ensureDir();
  }

  _ensureDir() {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
      console.log(`${LOG} Created posts directory: ${this.dir}`);
    }
  }

  _tsToFilename(ts) {
    return ts.replace(/:/g, '-');
  }

  _filenameToTs(filename) {
    const base = filename.replace('.json', '');
    const tIdx = base.indexOf('T');
    if (tIdx === -1) return base;
    const datePart = base.substring(0, tIdx);
    const timePart = base.substring(tIdx + 1).replace(/-/g, ':');
    return `${datePart}T${timePart}${timePart.endsWith('Z') ? '' : 'Z'}`;
  }

  _atomicWrite(filePath, data) {
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, filePath);
  }

  save(post) {
    this._ensureDir();
    const ts = post.timestamp || new Date().toISOString();
    const tsFilename = immutableArchiveFilename(post, this._tsToFilename(ts));

    const archivePath = join(this.dir, tsFilename);
    if (!existsSync(archivePath)) this._atomicWrite(archivePath, post);
    assertArtifactPublishable(post, 'Post', { requireLineage: true });
    assertCandidateNotOlder(post, this.getLatest(), 'Post');
    this._atomicWrite(join(this.dir, 'latest.json'), post);
    console.log(`${LOG} Saved post: latest.json + ${tsFilename}`);
    this._prune();
  }

  getLatest() {
    const latestPath = join(this.dir, 'latest.json');
    try {
      if (!existsSync(latestPath)) return null;
      return JSON.parse(readFileSync(latestPath, 'utf-8'));
    } catch (err) {
      console.error(`${LOG} Error reading latest.json:`, err.message);
      return null;
    }
  }

  getByGenerationId(jobId) {
    if (!jobId || !existsSync(this.dir)) return null;
    for (const file of readdirSync(this.dir).filter(name => name.endsWith('.json'))) {
      try {
        const data = JSON.parse(readFileSync(join(this.dir, file), 'utf8'));
        if (data.generationJobId === jobId || data.generation?.jobId === jobId) return data;
      } catch { /* preserve unreadable files for diagnosis */ }
    }
    return null;
  }

  getArchive(limit = 50) {
    try {
      if (!existsSync(this.dir)) return [];
      const files = readdirSync(this.dir)
        .filter(f => f.endsWith('.json') && f !== 'latest.json' && !f.endsWith('.tmp'))
        .sort((a, b) => b.localeCompare(a))
        .slice(0, limit);

      const archive = [];
      for (const file of files) {
        try {
          const raw = readFileSync(join(this.dir, file), 'utf-8');
          const data = JSON.parse(raw);
          if (!isArtifactPublishable(data, { requireLineage: true })) continue;
          archive.push({
            timestamp: data.timestamp || this._filenameToTs(file),
            filename: file,
            en: { title: data.en?.title || 'Untitled', content: data.en?.content || '', evidence: data.en?.evidence || [], evidenceStatus: data.en?.evidenceStatus || null, citationValidation: data.en?.citationValidation || null },
            ar: { title: data.ar?.title || 'بدون عنوان', content: data.ar?.content || '', evidence: data.ar?.evidence || [], evidenceStatus: data.ar?.evidenceStatus || null, citationValidation: data.ar?.citationValidation || null },
            evidence: data.evidence || [],
            schemaVersion: data.schemaVersion || null,
            snapshot: data.snapshot || null,
            generation: data.generation || null,
            generationJobId: data.generationJobId || null,
          });
        } catch { /* skip corrupt files */ }
      }
      return archive;
    } catch (err) {
      console.error(`${LOG} Error reading archive:`, err.message);
      return [];
    }
  }

  getByTimestamp(ts) {
    try {
      if (typeof ts !== 'string' || ts.length > 120 || !/^\d{4}-\d{2}-\d{2}T\d{2}(?::|-)\d{2}(?::|-)\d{2}(?:\.\d{1,3})?Z?(?:--[A-Za-z0-9_-]+--[a-f0-9]{16})?(?:\.json)?$/.test(ts)) return null;
      let filePath = join(this.dir, ts.endsWith('.json') ? ts : ts + '.json');
      if (existsSync(filePath)) {
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        return isArtifactPublishable(data, { requireLineage: true }) ? data : null;
      }

      const safeName = this._tsToFilename(ts);
      filePath = join(this.dir, safeName + '.json');
      if (existsSync(filePath)) {
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        return isArtifactPublishable(data, { requireLineage: true }) ? data : null;
      }

      return null;
    } catch (err) {
      console.error(`${LOG} Error reading post by timestamp "${ts}":`, err.message);
      return null;
    }
  }

  /**
   * Get recent post topics for deduplication.
   * @param {number} n - Number of recent posts to retrieve (default 24 = ~6 hours)
   * @returns {Array<{title_en: string, title_ar: string}>}
   */
  getRecentTopics(n = 24) {
    try {
      if (!existsSync(this.dir)) return [];
      const files = readdirSync(this.dir)
        .filter(f => f.endsWith('.json') && f !== 'latest.json' && !f.endsWith('.tmp'))
        .sort((a, b) => b.localeCompare(a))
        .slice(0, n);

      const topics = [];
      for (const file of files) {
        try {
          const raw = readFileSync(join(this.dir, file), 'utf-8');
          const data = JSON.parse(raw);
          if (!isArtifactPublishable(data, { requireLineage: true })) continue;
          topics.push({
            title_en: data.en?.title || '',
            title_ar: data.ar?.title || '',
            snippet_en: (data.en?.content || '').substring(0, 100),
          });
        } catch { /* skip */ }
      }
      return topics;
    } catch {
      return [];
    }
  }

  /**
   * Check if new content is semantically duplicate of recent posts.
   * @param {string} newContentEN - English content of the new post
   * @param {number} threshold - Jaccard similarity threshold (default 0.45)
   * @returns {{ isDuplicate: boolean, bestMatch: string, similarity: number }}
   */
  checkDuplicate(newContentEN, threshold = 0.45) {
    const newTokens = tokenize(newContentEN);
    if (newTokens.size === 0) return { isDuplicate: false, bestMatch: '', similarity: 0 };

    let bestSim = 0;
    let bestMatch = '';

    try {
      const files = readdirSync(this.dir)
        .filter(f => f.endsWith('.json') && f !== 'latest.json' && !f.endsWith('.tmp'))
        .sort((a, b) => b.localeCompare(a))
        .slice(0, 12);

      for (const file of files) {
        try {
          const data = JSON.parse(readFileSync(join(this.dir, file), 'utf-8'));
          if (!isArtifactPublishable(data, { requireLineage: true })) continue;
          const oldTokens = tokenize(data.en?.content);
          const sim = jaccardSimilarity(newTokens, oldTokens);
          if (sim > bestSim) {
            bestSim = sim;
            bestMatch = data.en?.title || file;
          }
        } catch { /* skip corrupt */ }
      }
    } catch { /* dir missing */ }

    return { isDuplicate: bestSim >= threshold, bestMatch, similarity: bestSim };
  }

  _prune() {
    try {
      const cutoff = Date.now() - PRUNE_AGE_MS;
      const files = readdirSync(this.dir)
        .filter(f => f.endsWith('.json') && f !== 'latest.json' && !f.endsWith('.tmp'));

      let pruned = 0;
      for (const file of files) {
        const ts = this._filenameToTs(file);
        const fileTime = new Date(ts).getTime();
        if (!isNaN(fileTime) && fileTime < cutoff) {
          try { unlinkSync(join(this.dir, file)); pruned++; } catch { /* ignore */ }
        }
      }
      if (pruned > 0) console.log(`${LOG} Pruned ${pruned} post(s) older than 24h`);
    } catch (err) {
      console.error(`${LOG} Prune error:`, err.message);
    }
  }
}
