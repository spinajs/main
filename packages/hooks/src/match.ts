import type { ActionPattern } from './contracts.js';

/** '*' matches every action, 'a.b.*' every action under 'a.b.' (not 'a.b' itself), any other pattern only itself. */
export function matches(pattern: ActionPattern, action: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return action.startsWith(pattern.slice(0, -1));
  return pattern === action;
}
