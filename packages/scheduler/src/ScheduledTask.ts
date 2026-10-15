import { MethodNotImplemented } from '@spinajs/exceptions';

export class ScheduledTask {
  // Emit-mode schedules never call execute(); inline ones must override it.
  public execute(_ctx: unknown): Promise<unknown> | unknown {
    throw new MethodNotImplemented(`${this.constructor.name}.execute() is not implemented`);
  }
}
