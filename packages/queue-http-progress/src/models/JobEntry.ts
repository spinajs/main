import { DateTime } from 'luxon';

export type ProgressReporterFn = (percent: number, message?: string) => void;

/**
 * 
 * D E B U G
 * 
 * 
 * Shape stored in JobModel.Result when the worker produces a downloadable file.
 * The download endpoint at GET /jobs/v1/:jobId/download reads this to serve the file.
 */
// export interface IFileResult {
//     /** File path within the provider (e.g. relative path inside fs-temp). */
//     path: string;
//     /** @spinajs/fs provider name. Defaults to 'fs-temp'. */
//     provider?: string;
//     /** Suggested download filename sent in Content-Disposition. */
//     filename?: string;
//     /** When true the file is removed from storage after the first download. */
//     deleteAfterDownload?: boolean;
//     /** Any extra fields the worker wants to expose (message, reason, etc.). */
//     [key: string]: unknown;
// }

export interface IJobStatusResponse {
    jobId: string;
    progress: number; // 0-100
    status: 'pending' | 'processing' | 'done' | 'error';
    message?: string;
    error?: string;
    reason?: string;
    createdAt: DateTime;
}
