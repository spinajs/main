import { AsyncService } from '@spinajs/di';
import { DateTime } from 'luxon';
import crypto from 'crypto';
import { IJobStatusResponse, JobStatus } from '../models/JobEntry.js';

interface _JobEntry extends IJobStatusResponse {
    _expiresAt: DateTime;
}

export interface DownloadEntry {
    path: string;
    provider: string;
    filename: string;
    expiresAt: DateTime;
}

export class JobProgressService extends AsyncService {

    private _jobs = new Map<string, _JobEntry>();
    private _downloads = new Map<string, DownloadEntry>();
    private _gcInterval!: NodeJS.Timeout;

    public async resolve() {
        this._gcInterval = setInterval(() => this._gc(), 5 * 60 * 1000);
        await super.resolve();
    }

    public async dispose() {
        clearInterval(this._gcInterval);
    }

    public create(): string {
        const jobId = crypto.randomUUID();
        this._jobs.set(jobId, {
            jobId,
            progress: 0,
            status: 'pending' as JobStatus,
            createdAt: DateTime.now().toISO()!,
            _expiresAt: DateTime.now().plus({ hours: 1 }),
        });
        return jobId;
    }

    public update(jobId: string, percent: number, message?: string): void {
        const job = this._assertJob(jobId);
        job.progress = Math.min(100, Math.max(0, percent));
        job.status = 'processing';
        if (message !== undefined) job.message = message;
    }

    public complete(jobId: string, downloadToken?: string): void {
        const job = this._assertJob(jobId);
        job.progress = 100;
        job.status = 'done';
        if (downloadToken !== undefined) job.downloadToken = downloadToken;
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

    public createDownloadToken(path: string, provider: string, filename: string): string {
        const token = crypto.randomUUID();
        this._downloads.set(token, {
            path,
            provider,
            filename,
            expiresAt: DateTime.now().plus({ minutes: 15 }),
        });
        return token;
    }

    public consumeDownloadToken(token: string): DownloadEntry | undefined {
        const entry = this._downloads.get(token);
        if (!entry || entry.expiresAt < DateTime.now()) return undefined;
        this._downloads.delete(token);
        return entry;
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
        for (const [token, dl] of this._downloads) {
            if (dl.expiresAt < now) this._downloads.delete(token);
        }
    }
}
