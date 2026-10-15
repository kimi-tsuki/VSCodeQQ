// Keep one of three request slots available for newly activated chats.
// Duplicate requests share a promise; a queued request can move to the front.
export class HistoryQueue {
  private jobs = new Map<string, { priority: number; run: () => Promise<void>; promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void; active: boolean }>();
  private running = 0;
  request(key: string, priority: number, run: () => Promise<void>): Promise<void> {
    const existing = this.jobs.get(key);
    if (existing) { existing.priority = Math.min(existing.priority, priority); this.drain(); return existing.promise; }
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.jobs.set(key, { priority, run, promise, resolve, reject, active: false });
    this.drain(); return promise;
  }
  private drain(): void {
    while (this.running < 3) {
      const next = [...this.jobs].filter(([, job]) => !job.active).sort((a, b) => a[1].priority - b[1].priority)[0];
      if (!next || (next[1].priority > 0 && this.running >= 2)) return;
      const [key, job] = next; job.active = true; this.running++;
      const finish = (failed: boolean, error?: unknown) => {
        this.running--; if (this.jobs.get(key) === job) this.jobs.delete(key);
        if (failed) job.reject(error); else job.resolve(); this.drain();
      };
      void Promise.resolve().then(job.run).then(() => finish(false), error => finish(true, error));
    }
  }
  clear(): void {
    // Running requests are guarded by their account token at the consumer.
    for (const [key, job] of this.jobs) if (!job.active) { this.jobs.delete(key); job.resolve(); }
  }
}
