import { DI } from "@spinajs/di";
import { IOFail } from "@spinajs/exceptions";
import { fs } from "@spinajs/fs";
import { Log, Logger } from "@spinajs/log-common";
import { QueueJob, Job } from "@spinajs/queue";

@Job()
export class LazyUploadJob extends QueueJob {

    @Logger('LazyFileUploader')
    protected Log: Log;

    // Filesystem to upload to
    public ToFilesystem: string;

    public Path: string;

    public SourceFilesystem: string;

    public async execute(progress: (p: number) => Promise<void>) {

        const sFs = DI.resolve<fs>("__file_provider__", [this.SourceFilesystem]);
        const tFs = DI.resolve<fs>("__file_provider__", [this.ToFilesystem]);

        if (!sFs) {
            throw new IOFail(`Filesystem ${this.SourceFilesystem} not exists, pleas check your configuration`);
        }

        if (!tFs) {
            throw new IOFail(`Filesystem ${this.ToFilesystem} not exists, pleas check your configuration`);
        }

        this.Log.trace(`Copying ${this.Path} from ${this.SourceFilesystem} to ${this.ToFilesystem}`);
        this.Log.timeStart(`[COPY] ${this.Path}`);

        await progress(0);

        await sFs.copy(this.Path, this.Path, tFs);

        await progress(100);

        const d = this.Log.timeEnd(`[COPY] ${this.Path}`);
        this.Log.trace(`Copied ${this.Path} from ${this.SourceFilesystem} to ${this.ToFilesystem} in ${d}ms`);

        return 'finished';
    }
}