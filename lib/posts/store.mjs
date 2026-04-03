// Moraqeb Post Storage
// Short-form intelligence updates — JSON file storage with atomic writes, 24h pruning, and dedup support
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';

const LOG = '[Moraqeb PostStore]';
const PRUNE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

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
    return ts.replace(/:/g, '-').replace(/\.\d+Z?$/, '');
  }

  _filenameToTs(filename) {
    const base = filename.replace('.json', '');
    const tIdx = base.indexOf('T');
    if (tIdx === -1) return base;
    const datePart = base.substring(0, tIdx);
    const timePart = base.substring(tIdx + 1).replace(/-/g, ':');
    return `${datePart}T${timePart}Z`;
  }

  _atomicWrite(filePath, data) {
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, filePath);
  }

  save(post) {
    this._ensureDir();
    const ts = post.timestamp || new Date().toISOString();
    const tsFilename = this._tsToFilename(ts) + '.json';

    this._atomicWrite(join(this.dir, 'latest.json'), post);
    this._atomicWrite(join(this.dir, tsFilename), post);
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
          archive.push({
            timestamp: data.timestamp || this._filenameToTs(file),
            filename: file,
            en: { title: data.en?.title || 'Untitled', content: data.en?.content || '' },
            ar: { title: data.ar?.title || 'بدون عنوان', content: data.ar?.content || '' },
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
      let filePath = join(this.dir, ts.endsWith('.json') ? ts : ts + '.json');
      if (existsSync(filePath)) return JSON.parse(readFileSync(filePath, 'utf-8'));

      const safeName = this._tsToFilename(ts);
      filePath = join(this.dir, safeName + '.json');
      if (existsSync(filePath)) return JSON.parse(readFileSync(filePath, 'utf-8'));

      if (existsSync(this.dir)) {
        const files = readdirSync(this.dir).filter(f => f.endsWith('.json') && f !== 'latest.json' && !f.endsWith('.tmp'));
        for (const file of files) {
          if (file.includes(ts) || this._filenameToTs(file).includes(ts)) {
            return JSON.parse(readFileSync(join(this.dir, file), 'utf-8'));
          }
        }
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
          topics.push({
            title_en: data.en?.title || '',
            title_ar: data.ar?.title || '',
          });
        } catch { /* skip */ }
      }
      return topics;
    } catch {
      return [];
    }
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
