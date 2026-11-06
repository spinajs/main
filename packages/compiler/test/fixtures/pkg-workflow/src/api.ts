export interface WaitOptions {
  permission?: string;
  timeout?: string;
}

export interface Ctx {
  step<T>(name: string, fn: () => T): Promise<T>;
  waitForEvent(name: string, opts?: WaitOptions): Promise<unknown>;
}

export function Workflow(_name: string, _options?: { version?: number }): ClassDecorator {
  return () => undefined;
}
