import { DI } from '@spinajs/di';
import { JobProgressService } from './services/JobProgressService.js';

const REPORTER_PARAM_META = Symbol('http-progress:reporter:param');

/**
 * Marks a controller method parameter to receive the IProgressReporter callback.
 * The slot is filled by @TrackProgress before invoking the original method.
 */
export function ProgressReporter() {
    return (_target: object, propertyKey: string | symbol, parameterIndex: number) => {
        Reflect.defineMetadata(REPORTER_PARAM_META, parameterIndex, _target, propertyKey);
    };
}

/**
 * Method decorator. Tracks execution progress of an HTTP endpoint.
 * - Reads `jobId` from ?jobId= query param
 * - If present: creates job, injects reporter, wraps execution, marks done/error
 * - The original method return value is left completely unchanged
 * - If no jobId: executes normally, @ProgressReporter() receives a no-op
 *
 * Frontend usage:
 *   const jobId = crypto.randomUUID();
 *   fetch(`/endpoint?jobId=${jobId}`, { method: 'POST', body: formData });
 *   // poll GET /jobs/v1/${jobId}/status in parallel while waiting for the response
 */
export function TrackProgress() {
    return function (_target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const original: (...args: any[]) => Promise<any> = descriptor.value;

        descriptor.value = async function (this: any, ...args: any[]) {
            // spinajs sets this.Request on the controller instance before calling the method
            const jobId: string | undefined =
                typeof this.Request?.query?.jobId === 'string'
                    ? this.Request.query.jobId
                    : undefined;

            const service: JobProgressService = await DI.resolve(JobProgressService);

            const reporterIndex: number | undefined = Reflect.getMetadata(
                REPORTER_PARAM_META,
                _target,
                propertyKey,
            );

            if (jobId) {
                service.create(jobId);
            }

            if (reporterIndex !== undefined) {
                if (jobId) {
                    args[reporterIndex] = (percent: number, message?: string) =>
                        service.update(jobId, percent, message);
                } else {
                    // no jobId supplied - progress() calls are safe but silently ignored
                    args[reporterIndex] = (_p: number, _m?: string) => { /* noop */ };
                }
            }

            try {
                const result = await original.apply(this, args);
                if (jobId) service.complete(jobId);
                return result; // original response, completely untouched
            } catch (err) {
                if (jobId) service.fail(jobId, err as Error);
                throw err;    // re-throw so spinajs handles the error response normally
            }
        };

        return descriptor;
    };
}
