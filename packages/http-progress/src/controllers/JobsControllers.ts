import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, FileResponse, Get, Param } from '@spinajs/http';
import { ResourceNotFound } from '@spinajs/exceptions';
import { JobProgressService } from '../services/JobProgressService.js';

@BasePath('jobs/v1')
export class JobsController extends BaseController {

    @Autoinject()
    private Jobs!: JobProgressService;

    @Get(':jobId/status')
    public getStatus(@Param() jobId: string) {
        const job = this.Jobs.get(jobId);
        if (!job) throw new ResourceNotFound(`Job ${jobId} not found`);
        return job;
    }

    @Get(':jobId/download/:token')
    public download(@Param() _jobId: string, @Param() token: string) {
        const entry = this.Jobs.consumeDownloadToken(token);
        if (!entry) throw new ResourceNotFound('Download token is invalid or has expired');
        return new FileResponse({
            path: entry.path,
            provider: entry.provider,
            deleteAfterDownload: true,
            filename: entry.filename,
        });
    }
}
