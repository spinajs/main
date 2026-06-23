import { DateTime } from 'luxon';

export interface IJobStatusResponse {
    jobId: string;
    progress: number; // 0-100
    status: 'error' | 'success' | 'created' | 'executing';
    message?: string;
    createdAt: DateTime;
}
