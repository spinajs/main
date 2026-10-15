import { MethodNotImplemented } from '@spinajs/exceptions';
import type { RunContext } from './run/RunContext.js';

export class ScheduledTask {
  // Emit-mode schedules never call execute(); inline ones must override it.
  public execute(_ctx: RunContext): Promise<unknown> | unknown {
    throw new MethodNotImplemented(`${this.constructor.name}.execute() is not implemented`);
  }
}
