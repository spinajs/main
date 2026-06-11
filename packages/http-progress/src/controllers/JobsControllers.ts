import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Get, Param } from '@spinajs/http';
import { ResourceNotFound } from '@spinajs/exceptions';
import { JobProgressService } from '../services/JobProgressService.js';
import { IJobStatusResponse } from '../models/JobEntry.js';

@BasePath('jobs/v1')
export class JobsController extends BaseController {

    @Autoinject()
    private Jobs!: JobProgressService;

    @Get(':jobId/status')
    public getStatus(@Param('jobId') jobId: string): IJobStatusResponse {
        const job = this.Jobs.get(jobId);
        if (!job) throw new ResourceNotFound(`Job ${jobId} not found`);
        return job;
    }
}
