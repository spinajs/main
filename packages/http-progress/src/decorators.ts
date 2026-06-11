import { DI } from '@spinajs/di';
import { HTTP_STATUS_CODE } from '@spinajs/http';
import { JobProgressService } from './services/JobProgressService.js';
import { BackgroundFileResult, IProgressReporter } from './models/JobEntry.js';

const REPORTER_PARAM_META = Symbol('http-progress:reporter:param');

/**
 * Marks a controller method parameter to receive the IProgressReporter callback.
 * The parameter slot is left undefined by spinajs route-arg system and filled
 * by @BackgroundJob before invoking the original method.
 */
export function ProgressReporter() {
    return (_target: object, propertyKey: string | symbol, parameterIndex: number) => {
        Reflect.defineMetadata(REPORTER_PARAM_META, parameterIndex, _target, propertyKey);
    };
}

/**
 * Method decorator. Converts an HTTP endpoint into an async background job:
 * - Immediately returns HTTP 202 { jobId }
 * - Runs the original handler in background via setImmediate
 * - Tracks progress through JobProgressService
 * - If the handler returns BackgroundFileResult, creates a one-time download token
 */
export function BackgroundJob() {
    return function (_target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const original: (...args: any[]) => Promise<any> = descriptor.value;

        descriptor.value = async function (this: any, ...args: any[]) {
            const service: JobProgressService = await DI.resolve(JobProgressService);
            const jobId = service.create();

            const reporterIndex: number | undefined = Reflect.getMetadata(
                REPORTER_PARAM_META,
                _target,
                propertyKey,
            );

            if (reporterIndex !== undefined) {
                const reporter: IProgressReporter = (percent, message) =>
                    service.update(jobId, percent, message);
                args[reporterIndex] = reporter;
            }

            setImmediate(async () => {
                try {
                    service.update(jobId, 0);
                    const result = await original.apply(this, args);

                    if (result instanceof BackgroundFileResult) {
                        const token = service.createDownloadToken(
                            result.path,
                            result.provider,
                            result.filename,
                        );
                        service.complete(jobId, token);
                    } else {
                        service.complete(jobId);
                    }
                } catch (err) {
                    service.fail(jobId, err as Error);
                }
            });

            if (this.Response?.status) {
                this.Response.status(HTTP_STATUS_CODE.ACCEPTED);
            }
            return { jobId };
        };

        return descriptor;
    };
}
