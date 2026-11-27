const tenant = (description: string) => ({ types: ['tenant'], description });

/**
 * The tenant permissions and roles. A package config file loads whether or not the app imports
 * `@spinajs/tenancy-orm/authz`; nothing holds these roles until the app assigns them at a `tenant:<id>` scope.
 */
const tenancyAuthz = {
  authz: {
    permissions: {
      'tenant:enter': tenant('Enter the tenant: run requests, jobs and commands in its scope'),
      'tenant:members.add': tenant('Make a principal a member of the tenant, or give it a tenant role'),
      'tenant:members.remove': tenant('Take a principal out of the tenant'),
      'tenant:settings.manage': tenant('Change the settings of the tenant'),
    },
    rbac: {
      ladders: { tenant: { roles: ['tenant.member', 'tenant.admin', 'tenant.owner'] } },
      roles: {
        'tenant.member': { subjectSet: true, scopeTypes: ['tenant'], ladder: 'tenant', grants: ['tenant:enter'] },
        'tenant.admin': { scopeTypes: ['tenant'], ladder: 'tenant', extends: ['tenant.member'], grants: ['tenant:members.add', 'tenant:members.remove', 'tenant:settings.manage'] },
        'tenant.owner': { scopeTypes: ['tenant'], ladder: 'tenant', extends: ['tenant.admin'], grants: [] as string[] },
      },
    },
    admin: {
      // AuthzAdmin checks these at a tenant scope instead of authz:*; the exact kind wins over its family.
      permissions: {
        'assignment.grant': { tenant: 'tenant:members.add' },
        'assignment.*': { tenant: 'tenant:members.remove' },
        'set.addMember': { tenant: 'tenant:members.add' },
        'set.*': { tenant: 'tenant:members.remove' },
        'scope.setAttributes': { tenant: 'tenant:settings.manage' },
        'list.assignments': { tenant: 'tenant:members.add' },
      },
      guard: { keepHolders: [{ role: 'tenant.owner', scopeType: 'tenant' }] },
    },
  },
};

export default tenancyAuthz;
