import type { ActionPattern } from './contracts.js';

/** '*' matches every action, 'a.b.*' every action under 'a.b.' (not 'a.b' itself), any other pattern only itself. */
export function matches(_pattern: ActionPattern, _action: string): boolean {
  throw new Error('not implemented: matches');
}
