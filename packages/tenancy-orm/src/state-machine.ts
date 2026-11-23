import { TENANT_STATES } from '@spinajs/tenancy';
import type { TenantState } from '@spinajs/tenancy';

// provisioning -> active <-> suspended -> deleting -> deleted, and provisioning -> deleting for a provisioning that failed
const TRANSITIONS = new Map<TenantState, readonly TenantState[]>([
  ['provisioning', ['active', 'deleting']],
  ['active', ['suspended']],
  ['suspended', ['active', 'deleting']],
  ['deleting', ['deleted']],
  ['deleted', []],
]);

export function isTenantState(value: unknown): value is TenantState {
  return TENANT_STATES.some((state) => state === value);
}

/** The states a tenant in `from` may move to. */
export function nextStates(from: TenantState): readonly TenantState[] {
  return TRANSITIONS.get(from) ?? [];
}

export function canTransition(from: TenantState, to: TenantState): boolean {
  return nextStates(from).includes(to);
}
