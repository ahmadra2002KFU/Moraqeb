import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { assertArtifactPublishable, assertCandidateNotOlder, immutableArchiveFilename, isArtifactPublishable } from '../generation/quality-gate.mjs';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class ExecutiveStore {
  constructor(dir) {
    this.dir = dir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  _filename(timestamp) {
    return timestamp.replace(/:/g, '-') + '.json';
  }

  _write(path, value) {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, path);
  }

  save(brief) {
    const timestamp = brief.timestamp || new Date().toISOString();
    const archive = immutableArchiveFilename(brief, this._filename(timestamp).replace(/\.json$/, ''));
    const archivePath = join(this.dir, archive);
    if (!existsSync(archivePath)) this._write(archivePath, brief);
    assertArtifactPublishable(brief, 'Executive', { requireLineage: true });
    assertCandidateNotOlder(brief, this.getLatest(), 'Executive');
    this._write(join(this.dir, 'latest.json'), brief);
    this._prune();
  }

  getLatest() {
    try {
      const path = join(this.dir, 'latest.json');
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    } catch { return null; }
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

  getArchive(limit = 30) {
    try {
      return readdirSync(this.dir)
        .filter(file => file.endsWith('.json') && file !== 'latest.json')
        .sort((a, b) => b.localeCompare(a))
        .slice(0, Math.max(1, Math.min(Number(limit) || 30, 100)))
        .map(file => {
          try {
            const data = JSON.parse(readFileSync(join(this.dir, file), 'utf8'));
            if (!isArtifactPublishable(data, { requireLineage: true })) return null;
            return { timestamp: data.timestamp, generatedAt: data.generatedAt, riskLevel: data.en?.riskLevel, title: data.en?.title, filename: file };
          } catch { return null; }
        }).filter(Boolean);
    } catch { return []; }
  }

  _prune() {
    const cutoff = Date.now() - RETENTION_MS;
    try {
      for (const file of readdirSync(this.dir).filter(item => item.endsWith('.json') && item !== 'latest.json')) {
        try {
          const data = JSON.parse(readFileSync(join(this.dir, file), 'utf8'));
          if (new Date(data.generatedAt || data.timestamp).getTime() < cutoff) unlinkSync(join(this.dir, file));
        } catch { /* retain unreadable files for diagnosis */ }
      }
    } catch { /* no-op */ }
  }
}
