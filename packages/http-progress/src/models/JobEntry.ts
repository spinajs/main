import { DateTime } from 'luxon';

export type JobStatus = 'pending' | 'processing' | 'done' | 'error';

export interface IJobStatusResponse {
    jobId: string;
    progress: number; // 0-100
    status: JobStatus;
    message?: string;
    error?: string;
    createdAt: DateTime;
}

export type IProgressReporter = (percent: number, message?: string) => void;
