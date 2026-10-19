import type { Class } from '@spinajs/di';
import { BaseController, HttpServer } from '@spinajs/http';
export interface TestApp {
    readonly server: HttpServer;
    readonly port: number;
    request(): ChaiHttp.Agent;
}
/**
 * Boots an http server on a free port over testHost's in-memory configuration (so `hostHarness`
 * can share it), seeded with the package defaults and `config`. The controllers are registered for
 * this app only. Pair with `stopApp()` in an `after` hook.
 */
export declare function startApp(opts?: {
    controllers?: Class<BaseController>[];
    config?: Readonly<Record<string, unknown>>;
}): Promise<TestApp>;
/** Stops the server and removes what `startApp` added; never `DI.clearCache()`. */
export declare function stopApp(): Promise<void>;
//# sourceMappingURL=app.d.ts.map