import { Exception } from '@spinajs/exceptions';

/** A before hook refused the action with `ctx.refuse(code)`. */
export class ActionRefused extends Exception {
  constructor(public readonly action: string, public readonly code: string, message?: string) {
    super(message ?? `${action} refused: ${code}`);
  }
}

/** A before hook threw something other than a refusal, timed out, or the run passed hooks.maxDepth. */
export class ActionHookFailed extends Exception {
  constructor(public readonly action: string, public readonly hook: string, public readonly reason: 'error' | 'timeout' | 'depth') {
    super(`${hook} failed on ${action}: ${reason}`);
  }
}
