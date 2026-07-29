
/**
 * Merges a grants fragment into an accumulator, one resource at a time.
 *
 * A plain object spread merges at the RESOURCE level, so a later fragment that names a
 * resource replaces the whole action map already collected for it. Grants have to merge one
 * level deeper — per action — otherwise a role that adds `create:any` to a resource an
 * inherited role also grants loses that action entirely.
 *
 * `$extend` is bookkeeping for the caller, not a resource, so it never reaches the output.
 *
 * @param base - accumulated grants
 * @param add - fragment to merge in; its actions win on conflict
 * @returns a new object, neither argument is mutated
 */
const _mergeResourceGrants = (base: { [key: string]: any }, add: { [key: string]: any }) => {
    const merged = { ...base };

    for (const [resource, actions] of Object.entries(add)) {
        if (resource === '$extend') {
            continue;
        }

        merged[resource] = { ...(merged[resource] ?? {}), ...actions };
    }

    return merged;
};

/**
 * Recursively unwinds and combines grants for a given role, including inherited roles.
 *
 * @param role - The role for which grants need to be resolved.
 * @param grants - An object containing all roles and their associated grants.
 * @param seen - Roles already visited on this branch; guards against cyclic `$extend`.
 * @returns An object representing the combined grants for the given role and its inherited roles.
 *
 * This function resolves the `$extend` property in the grants object to include
 * permissions from inherited roles, merging them into a single object.
 *
 * Inherited roles are merged first and the role's own grants last, so the role always wins
 * on a conflicting action — the same precedence accesscontrol applies when it resolves
 * `$extend` itself. The result mirrors what `ac.can(role)` answers server-side; it is what
 * gets shipped to clients that rebuild an ACL from it.
 */
export const _unwindGrants = (role: string, grants: { [key: string]: any }, seen: Set<string> = new Set()) => {
    // a role reachable twice contributes the same grants both times, so skipping it only
    // stops the recursion from looping forever on a cyclic $extend
    if (seen.has(role)) {
        return {};
    }
    seen.add(role);

    const roleGrants = grants[role] || {};
    const inheritedRoles = roleGrants['$extend'] || [];

    const inherited = inheritedRoles.reduce(
        (acc: any, inheritedRole: any) => _mergeResourceGrants(acc, _unwindGrants(inheritedRole, grants, seen)),
        {},
    );

    return _mergeResourceGrants(inherited, roleGrants);
}

/**
 * Combines already unwound grant sets — eg. one per role of a multi-role user — into a single
 * map, merging per action for the same reason `_unwindGrants` does.
 *
 * @param grants - unwound grant maps; later entries win on a conflicting action
 */
export const _combineGrants = (...grants: { [key: string]: any }[]) => {
    return grants.reduce((acc, g) => _mergeResourceGrants(acc, g), {});
}
