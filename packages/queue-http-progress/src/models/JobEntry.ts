import { DateTime } from 'luxon';
import type { JobStatus } from '@spinajs/queue';

export interface IJobStatusResponse {
    jobId: string;
    progress: number; // 0-100
    status: JobStatus;
    /** Failure message ( from LastError ), present only for failed / retrying jobs. */
    message?: string;
    /** Attempts performed so far. */
    attempt?: number;
    /** Configured retry limit. */
    maxAttempts?: number;
    createdAt: DateTime;
    finishedAt?: DateTime;
}
