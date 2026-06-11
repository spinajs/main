import { AsyncService } from '@spinajs/di';
import { DateTime } from 'luxon';
import crypto from 'crypto';
import { IJobStatusResponse, JobStatus } from '../models/JobEntry.js';

interface _JobEntry extends IJobStatusResponse {
    _expiresAt: DateTime;
}

export class JobProgressService extends AsyncService {

    private _jobs = new Map<string, _JobEntry>();
    private _gcInterval!: NodeJS.Timeout;

    public async resolve() {
        // TODO: move GC to cron
        this._gcInterval = setInterval(() => this._gc(), 5 * 60 * 1000);
        await super.resolve();
    }

    public async dispose() {
        clearInterval(this._gcInterval);
    }

    public create(jobId?: string): string {
        const id = jobId ?? crypto.randomUUID();
        this._jobs.set(id, {
            jobId: id,
            progress: 0,
            status: 'pending' as JobStatus,
            createdAt: DateTime.now(),
            _expiresAt: DateTime.now().plus({ hours: 1 }),
        });
        return id;
    }

    public update(jobId: string, percent: number, message?: string): void {
        const job = this._assertJob(jobId);
        job.progress = Math.min(100, Math.max(0, percent));
        job.status = 'processing';
        if (message !== undefined) job.message = message;
    }

    public complete(jobId: string): void {
        const job = this._assertJob(jobId);
        job.progress = 100;
        job.status = 'done';
        job._expiresAt = DateTime.now().plus({ minutes: 15 });
    }

    public fail(jobId: string, error: Error): void {
        const job = this._assertJob(jobId);
        job.status = 'error';
        job.error = error.message;
        job._expiresAt = DateTime.now().plus({ minutes: 15 });
    }

    public get(jobId: string): IJobStatusResponse | undefined {
        const job = this._jobs.get(jobId);
        if (!job) return undefined;
        const { _expiresAt: _exp, ...rest } = job;
        return rest;
    }

    private _assertJob(jobId: string): _JobEntry {
        const job = this._jobs.get(jobId);
        if (!job) throw new Error(`Job ${jobId} not found`);
        return job;
    }

    private _gc(): void {
        const now = DateTime.now();
        for (const [id, job] of this._jobs) {
            if (job._expiresAt < now) this._jobs.delete(id);
        }
    }
}
