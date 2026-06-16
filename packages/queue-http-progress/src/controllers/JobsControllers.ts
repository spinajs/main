import { BaseController, BasePath, Get, Ok, Param } from '@spinajs/http';
import { ResourceNotFound } from '@spinajs/exceptions';
import { JobModel } from '@spinajs/queue';
import { IJobStatusResponse } from '../models/JobEntry.js';

function mapStatus(s: string): IJobStatusResponse['status'] {
    switch (s) {
        case 'created': return 'pending';
        case 'executing': return 'processing';
        case 'success': return 'done';
        default: return 'error';
    }
}

@BasePath('jobs/v1')
export class JobsController extends BaseController {

    @Get(':jobId/status')
    public async getStatus(@Param('jobId') jobId: string): Promise<Ok> {
        const row = (await JobModel.select().where('JobId', jobId).first()) as JobModel<{ reason?: string; message?: string; error?: string }> | undefined;
        if (!row) throw new ResourceNotFound(`Job ${jobId} not found`);

        const ctx = row.Result ?? {};
        const response: IJobStatusResponse = {
            jobId: row.JobId,
            progress: row.Progress,
            status: mapStatus(row.Status),
            message: ctx.message,
            error: ctx.error,
            reason: ctx.reason,
            createdAt: row.CreatedAt,
        };
        return new Ok(response);
    }
}
