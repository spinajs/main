import { ClassInfo } from '@spinajs/di';
import { BaseController, ControllerSource } from '@spinajs/http';
import { Log } from '@spinajs/log';
/**
 * Hands the explain route to http only while `authz.http.explainRoute.enabled` and outside
 * production, so in production it is never registered and a request gets 404 (H19, B41).
 */
export declare class ExplainControllerSource extends ControllerSource {
    protected Log: Log;
    protected ExplainEnabled: boolean;
    protected IsProduction: boolean | undefined;
    getControllers(): Promise<ClassInfo<BaseController>[]>;
}
//# sourceMappingURL=source.d.ts.map