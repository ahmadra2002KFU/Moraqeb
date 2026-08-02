import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

const LOG = '[GenerationQueue]';

export class GenerationQueue {
  constructor(dir, handlers = {}, options = {}) {
    this.dir = dir;
    this.statePath = join(dir, 'state.json');
    this.handlers = handlers;
    this.retryDelaysMs = options.retryDelaysMs || [5_000, 30_000, 120_000];
    this.maxAttempts = options.maxAttempts || this.retryDelaysMs.length + 1;
    this.now = options.now || (() => new Date());
    this.processing = false;
    this.timer = null;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.state = this._load();
    this._recoverInterrupted();
    this._save();
  }

  _load() {
    if (!existsSync(this.statePath)) return { version: 1, jobs: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8'));
      if (parsed?.version === 1 && Array.isArray(parsed.jobs)) return parsed;
      throw new Error('unsupported schema');
    } catch (error) {
      throw new Error(`Generation queue state is corrupt; refusing to overwrite it (${error.message})`);
    }
  }

  _save() {
    const tmp = `${this.statePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    let fd;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(this.state, null, 2));
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tmp, this.statePath);
    } finally {
      if (fd != null) closeSync(fd);
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  }

  _recoverInterrupted() {
    const now = this.now().toISOString();
    for (const job of this.state.jobs) {
      if (job.status === 'running') {
        job.status = 'pending';
        job.runAt = now;
        job.updatedAt = now;
        job.lastError = 'Recovered interrupted job after process restart';
      }
    }
  }

  enqueue({ id, type, payload = {}, runAt = null }) {
    if (!id || !type) throw new Error('Queue jobs require id and type');
    if (this.state.jobs.some(job => job.id === id)) return false;
    const now = this.now().toISOString();
    this.state.jobs.push({
      id, type, payload, status: 'pending', attempts: 0,
      createdAt: now, updatedAt: now, runAt: runAt || now,
      startedAt: null, completedAt: null, lastError: null, result: null,
    });
    this._prune();
    this._save();
    return true;
  }

  getJob(id) {
    return this.state.jobs.find(job => job.id === id) || null;
  }

  getHistory(limit = 100) {
    return [...this.state.jobs]
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, Math.max(1, Math.min(Number(limit) || 100, 500)));
  }

  getStats() {
    const stats = { pending: 0, running: 0, completed: 0, failed: 0, superseded: 0, total: this.state.jobs.length };
    for (const job of this.state.jobs) if (job.status in stats) stats[job.status] += 1;
    return stats;
  }

  async processNext() {
    if (this.processing) return null;
    const nowMs = this.now().getTime();
    const job = this.state.jobs
      .filter(item => item.status === 'pending' && new Date(item.runAt).getTime() <= nowMs)
      .sort((a, b) => String(a.runAt).localeCompare(String(b.runAt)))[0];
    if (!job) return null;

    this.processing = true;
    const now = this.now().toISOString();
    job.status = 'running';
    job.attempts += 1;
    job.startedAt = now;
    job.updatedAt = now;
    this._save();

    try {
      const handler = this.handlers[job.type];
      if (typeof handler !== 'function') throw new Error(`No handler registered for ${job.type}`);
      const result = await handler(job.payload, job);
      const completedAt = this.now().toISOString();
      job.status = 'completed';
      job.completedAt = completedAt;
      job.updatedAt = completedAt;
      job.lastError = null;
      job.result = result ?? null;
      console.log(`${LOG} Completed ${job.id} on attempt ${job.attempts}`);
    } catch (error) {
      const failedAt = this.now();
      job.updatedAt = failedAt.toISOString();
      job.lastError = 'Generation job failed';
      if (job.attempts < this.maxAttempts) {
        const delay = this.retryDelaysMs[Math.min(job.attempts - 1, this.retryDelaysMs.length - 1)] || 0;
        job.status = 'pending';
        job.runAt = new Date(failedAt.getTime() + delay).toISOString();
        console.warn(`${LOG} Retry ${job.id} after provider/generation failure`);
      } else {
        job.status = 'failed';
        job.completedAt = failedAt.toISOString();
        console.error(`${LOG} Failed ${job.id} after ${job.attempts} attempts`);
      }
    } finally {
      this.processing = false;
      this._save();
    }
    return job;
  }

  start(intervalMs = 1_000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.processNext().catch(() => console.error(`${LOG} Worker persistence error`));
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  supersedeFailures(type, supersededBy) {
    let changed = 0;
    const now = this.now().toISOString();
    for (const job of this.state.jobs) {
      if (job.type !== type || job.status !== 'failed' || job.id === supersededBy) continue;
      job.status = 'superseded';
      job.updatedAt = now;
      job.result = { supersededBy };
      changed += 1;
    }
    if (changed) this._save();
    return changed;
  }

  _prune() {
    if (this.state.jobs.length <= 500) return;
    const active = this.state.jobs.filter(job => job.status === 'pending' || job.status === 'running');
    const finished = this.state.jobs
      .filter(job => job.status !== 'pending' && job.status !== 'running')
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, Math.max(0, 500 - active.length));
    this.state.jobs = [...active, ...finished];
  }
}
