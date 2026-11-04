import type { ControllerEntry } from './types.js';

/** The key a generated client files a controller's routes under: the class name without `Controller`, first letter lowered. */
export function controllerKey(controller: Pick<ControllerEntry, 'className'>): string {
  const base = controller.className.replace(/Controller$/, '');
  return base.charAt(0).toLowerCase() + base.slice(1);
}
