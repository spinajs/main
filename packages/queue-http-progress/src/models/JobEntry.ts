import { DateTime } from 'luxon';
import type { JobStatus } from '@spinajs/queue';

export interface IJobStatusResponse {
    jobId: string;
    progress: number; // 0-100
    status: JobStatus;
    /** Optional progress phase label (e.g. `loading`, `rendering`). */
    phase?: string;
    /** Optional progress message. */
    message?: string;
    /** Failure message ( from LastError ), present only for failed / retrying jobs. */
    error?: string;
    /** Attempts performed so far. */
    attempt?: number;
    /** Configured retry limit. */
    maxAttempts?: number;
    createdAt: DateTime;
    finishedAt?: DateTime;
}
