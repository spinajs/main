export const STORED_POLICY_PREFIX = 'stored:';

/** The opaque term that stands for the policy a database store held; replay (L3) splices that policy in at its place. */
export function storedPolicyName(model: string, store: string): string {
  return `${STORED_POLICY_PREFIX}${encodeURIComponent(model)}:${encodeURIComponent(store)}`;
}

export function parseStoredPolicyName(name: string): { model: string; store: string } | undefined {
  if (!name.startsWith(STORED_POLICY_PREFIX)) return undefined;
  const parts = name.slice(STORED_POLICY_PREFIX.length).split(':');
  if (parts.length !== 2) return undefined;
  try {
    return { model: decodeURIComponent(parts[0]), store: decodeURIComponent(parts[1]) };
  } catch {
    return undefined;
  }
}
