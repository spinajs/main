import { DateTime } from 'luxon';

export interface IJobStatusResponse {
    jobId: string;
    progress: number; // 0-100
    status: 'error' | 'success' | 'created' | 'executing' | 'retrying' | 'dead';
    /** Optional progress phase label (e.g. `loading`, `rendering`). */
    phase?: string;
    /** Optional progress message. */
    message?: string;
    createdAt: DateTime;
}
