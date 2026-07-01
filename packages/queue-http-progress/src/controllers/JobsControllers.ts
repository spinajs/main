import { BaseController, BasePath, Get, Ok, Param } from '@spinajs/http';
import { JobModel } from '@spinajs/queue';
import { IJobStatusResponse } from '../models/JobEntry.js';

@BasePath('jobs/v1')
export class JobsController extends BaseController {

    @Get(':jobId/status')
    public async getStatus(@Param('jobId') jobId: string): Promise<Ok> {
        const row = await JobModel.query().byJobId(jobId).firstOrFail();

        const failed = row.Status === 'error' || row.Status === 'dead' || row.Status === 'retrying';
        const response: IJobStatusResponse = {
            jobId: row.JobId,
            progress: row.Progress,
            status: row.Status,
            message: failed ? row.LastError : undefined,
            attempt: row.Attempt,
            maxAttempts: row.MaxAttempts,
            createdAt: row.CreatedAt,
            finishedAt: row.FinishedAt,
        };

        return new Ok(response);
    }
}
