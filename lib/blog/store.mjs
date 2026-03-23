// Moraqeb SITREP Blog Storage
// Simple JSON file storage with atomic writes, pruning, and archive listing
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';

const LOG = '[Moraqeb BlogStore]';
const PRUNE_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours

export class BlogStore {
  /**
   * @param {string} blogDir - Absolute path to the blog storage directory (e.g. runs/blog/)
   */
  constructor(blogDir) {
    this.dir = blogDir;
    this._ensureDir();
  }

  /** Create directory if it does not exist. */
  _ensureDir() {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
      console.log(`${LOG} Created blog directory: ${this.dir}`);
    }
  }

  /**
   * Convert an ISO timestamp to a safe filename component.
   * "2026-03-23T10:30:45.123Z" -> "2026-03-23T10-30-45"
   */
  _tsToFilename(ts) {
    return ts.replace(/:/g, '-').replace(/\.\d+Z?$/, '');
  }

  /**
   * Parse a timestamped filename back to an approximate ISO string.
   * "2026-03-23T10-30-45.json" -> "2026-03-23T10:30:45Z"
   */
  _filenameToTs(filename) {
    const base = filename.replace('.json', '');
    // Replace the dashes after 'T' back to colons (only the time portion)
    const tIdx = base.indexOf('T');
    if (tIdx === -1) return base;
    const datePart = base.substring(0, tIdx);
    const timePart = base.substring(tIdx + 1).replace(/-/g, ':');
    return `${datePart}T${timePart}Z`;
  }

  /**
   * Atomic write: write to a temp file then rename.
   * Prevents partial/corrupt reads on crash.
   */
  _atomicWrite(filePath, data) {
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, filePath);
  }

  /**
   * Save a SITREP to latest.json and a timestamped archive file.
   * Also prunes entries older than 48 hours.
   * @param {object} sitrep - { timestamp, en: { title, content }, ar: { title, content } }
   */
  save(sitrep) {
    this._ensureDir();

    const ts = sitrep.timestamp || new Date().toISOString();
    const tsFilename = this._tsToFilename(ts) + '.json';

    // Write latest.json (atomic)
    const latestPath = join(this.dir, 'latest.json');
    this._atomicWrite(latestPath, sitrep);

    // Write timestamped archive file (atomic)
    const archivePath = join(this.dir, tsFilename);
    this._atomicWrite(archivePath, sitrep);

    console.log(`${LOG} Saved SITREP: latest.json + ${tsFilename}`);

    // Prune old files
    this._prune();
  }

  /**
   * Read the latest SITREP.
   * @returns {object|null} Parsed SITREP or null if not found
   */
  getLatest() {
    const latestPath = join(this.dir, 'latest.json');
    try {
      if (!existsSync(latestPath)) return null;
      const raw = readFileSync(latestPath, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      console.error(`${LOG} Error reading latest.json:`, err.message);
      return null;
    }
  }

  /**
   * List archived SITREPs with just metadata (timestamp + titles).
   * Returns most recent entries first.
   * @param {number} limit - Max entries to return (default 20)
   * @returns {Array<{timestamp: string, filename: string, en: {title: string}, ar: {title: string}}>}
   */
  getArchive(limit = 20) {
    try {
      if (!existsSync(this.dir)) return [];

      const files = readdirSync(this.dir)
        .filter(f => f.endsWith('.json') && f !== 'latest.json' && !f.endsWith('.tmp'))
        .sort((a, b) => b.localeCompare(a)) // Descending — newest first
        .slice(0, limit);

      const archive = [];
      for (const file of files) {
        try {
          const raw = readFileSync(join(this.dir, file), 'utf-8');
          const data = JSON.parse(raw);
          archive.push({
            timestamp: data.timestamp || this._filenameToTs(file),
            filename: file,
            en: { title: data.en?.title || 'Untitled' },
            ar: { title: data.ar?.title || 'بدون عنوان' },
          });
        } catch {
          // Skip corrupt files silently
        }
      }

      return archive;
    } catch (err) {
      console.error(`${LOG} Error reading archive:`, err.message);
      return [];
    }
  }

  /**
   * Read the full SITREP for a specific timestamp.
   * @param {string} ts - Timestamp identifier (filename without extension, or the ISO timestamp)
   * @returns {object|null} Full SITREP or null
   */
  getByTimestamp(ts) {
    try {
      // Try direct filename match first
      let filePath = join(this.dir, ts.endsWith('.json') ? ts : ts + '.json');
      if (existsSync(filePath)) {
        return JSON.parse(readFileSync(filePath, 'utf-8'));
      }

      // Try converting ISO timestamp to filename format
      const safeName = this._tsToFilename(ts);
      filePath = join(this.dir, safeName + '.json');
      if (existsSync(filePath)) {
        return JSON.parse(readFileSync(filePath, 'utf-8'));
      }

      // Search archive files for a matching timestamp
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
      console.error(`${LOG} Error reading SITREP by timestamp "${ts}":`, err.message);
      return null;
    }
  }

  /**
   * Delete archive files older than 48 hours.
   */
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
          try {
            unlinkSync(join(this.dir, file));
            pruned++;
          } catch {
            // Ignore deletion errors
          }
        }
      }

      if (pruned > 0) {
        console.log(`${LOG} Pruned ${pruned} archive file(s) older than 48h`);
      }
    } catch (err) {
      console.error(`${LOG} Prune error:`, err.message);
    }
  }
}
