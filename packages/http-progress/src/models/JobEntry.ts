export type JobStatus = 'pending' | 'processing' | 'done' | 'error';

export interface IJobStatusResponse {
    jobId: string;
    progress: number;         // 0-100
    status: JobStatus;
    message?: string;
    error?: string;
    downloadToken?: string;   // present when status === 'done' and result was a file
    createdAt: string;        // ISO 8601
}

export type IProgressReporter = (percent: number, message?: string) => void;

/**
 * Return from a @BackgroundJob handler when the result is a downloadable file.
 * @BackgroundJob intercepts this and creates a one-time download token.
 * Use instead of FileResponse — the handler should not depend on HTTP internals.
 */
export class BackgroundFileResult {
    public readonly path: string;
    public readonly provider: string;
    public readonly filename: string;

    constructor(opts: { path: string; provider: string; filename: string }) {
        this.path = opts.path;
        this.provider = opts.provider;
        this.filename = opts.filename;
    }
}
