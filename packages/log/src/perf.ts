import { setPerfScopeBackend, IPerfScope } from "@spinajs/log-common";
import { LogContext } from "./context.js";

/**
 * Install the per-request perf-scope backend for the node runtime. Reads the
 * `perf` accumulator off the ambient async store ( which IS `req.storage` when
 * http runs an action, so the scope created by the http PerfRollup middleware
 * and mutated during the action is one and the same object ). Called from
 * {@link LogBotstrapper.bootstrap}.
 */
export function wirePerfScope(): void {
  setPerfScopeBackend({
    get: () => (LogContext.active().perf as IPerfScope | undefined) ?? null,
  });
}
