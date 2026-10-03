import type { Decision } from '@spinajs/authz';

export function filterFields<T>(decision: Decision, data: T, mode: 'read' | 'write'): { data: Partial<T>; removed: string[] } {
  void decision, data, mode;
  throw new Error('@spinajs/authz-orm: filterFields is not implemented yet');
}
