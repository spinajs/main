const SYSTEM_TASK = Symbol.for('spinajs:system-task');

/**
 * Declares that a schedule, CLI command or queue job runs as SYSTEM, and why. The reason is what an audit, the manifest
 * and `spinajs authz coverage` show for the entry point. A subclass does not inherit it.
 */
export function SystemTask(reason: string): ClassDecorator {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new TypeError('@SystemTask needs a reason');
  }

  return (target) => {
    Object.defineProperty(target, SYSTEM_TASK, { value: reason, enumerable: false, configurable: true });
  };
}

/** The `@SystemTask` reason declared on `target` itself, not on a base class. */
export function systemTaskOf(target: object): string | undefined {
  return Object.prototype.hasOwnProperty.call(target, SYSTEM_TASK) ? ((target as Record<symbol, string>)[SYSTEM_TASK]) : undefined;
}
