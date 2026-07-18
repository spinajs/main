import { BaseController, BasePath, Get, Ok, Param } from '@spinajs/http';
import { JobModel } from '@spinajs/queue';
import { IJobStatusResponse } from '../models/JobEntry.js';

@BasePath('jobs/v1')
export class JobsController extends BaseController {

    @Get(':jobId/status')
    public async getStatus(@Param('jobId') jobId: string): Promise<Ok> {
        const row = await JobModel.select().where('JobId', jobId).first();

        if (!row) {
            return new Ok({ jobId, status: 'queued', progress: 0, message: undefined, createdAt: undefined });
        }

        const ctx = row.Result ?? {};
        const response: IJobStatusResponse = {
            jobId: row.JobId,
            progress: row.Progress,
            status: row.Status,
            message: (ctx as any)?.Result,
            createdAt: row.CreatedAt,
        };

        return new Ok(response);
    }
}
