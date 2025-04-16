
/**
 * Recursively unwinds and combines grants for a given role, including inherited roles.
 * 
 * @param role - The role for which grants need to be resolved.
 * @param grants - An object containing all roles and their associated grants.
 * @returns An object representing the combined grants for the given role and its inherited roles.
 * 
 * This function resolves the `$extend` property in the grants object to include
 * permissions from inherited roles, merging them into a single object.
 */
export const _unwindGrants = (role: string, grants: { [key: string]: any }) => {
    const roleGrants = grants[role] || {};
    const inheritedRoles = roleGrants['$extend'] || [];

    // Combine the current role's grants with inherited roles' grants
    return inheritedRoles.reduce((acc: any, inheritedRole: any) => {
        return {
            ...acc,
            ..._unwindGrants(inheritedRole, grants),
        };
    }, roleGrants);
}

