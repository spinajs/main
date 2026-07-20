import { DateTime } from 'luxon';
import { JobModel } from '@spinajs/queue';

export interface IJobStatusResponse {
    jobId: string;
    progress: number; // 0-100
    /**
     * Derived from the single source of truth in `@spinajs/queue` so new job
     * states (e.g. `retrying` / `dead`) cannot drift out of sync again.
     */
    status: JobModel<unknown>['Status'] | 'queued';
    message?: string;
    createdAt?: DateTime;
}
