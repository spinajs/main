// An anonymised copy of a production 2.x app's rbac config (yourscreen-backend, packages/backend/src/config/rbac.ts):
// the shapes of its polsat.backoffice / yourscreen.supersalesman blocks, its packages and its non-grant keys.
// 'acme' stands for the app's own company, 'partner' for the back-office partner, Campaign* for the Arrow* models.

function createLegacyUserMiddleware(u) {
  return u;
}

const ATTACHMENTS = [{ name: 'logo.png', path: 'images/logo.png', provider: 'email-templates', cid: 'logo' }];

export default {
  rbac: {
    actions: {
      create: {
        afterCreate: [createLegacyUserMiddleware],
      },
    },
    email: {
      connection: 'acme-notifications',
      created: { enabled: true, template: 'account-mail.mjml', subject: 'Your account', attachments: ATTACHMENTS },
      changePassword: { enabled: true, template: 'account-mail.mjml', subject: 'Password reset', attachments: ATTACHMENTS },
    },
    password: {
      validation: {
        rule: { type: 'string', minLength: 8, pattern: '^(?=.*\\d).{8,}$' },
        description: 'At least 8 characters and one digit',
      },
      invite: { waitTime: 15 * 60 },
      resetUrl: 'https://panel.acme.example/set-password',
    },
    otpauth: { issuer: 'ACME' },
    session: {
      service: 'DbSessionStore',
      expiration: { service: 'SlidingExpiration', ttl: 24 * 60 },
      cookie: { sameSite: 'none', secure: true },
    },
    twoFactorAuth: { forceUser: true },
    accountTypes: { acme: ['acme.salesman', 'acme.supersalesman'], partner: ['partner.backoffice'] },
    admin: {
      roleGuard: { service: 'ScopedRoleGuard', preventEscalation: false },
    },
    token: {
      rolePolicy: { service: 'GrantSubsetTokenRolePolicy' },
      excludedRoles: ['route.*'],
    },
    roles: [{ Name: 'Stock editor', Description: 'Stock message dynamic content editor' }],
    grants: {
      system: {
        $extend: ['admin', 'admin.campaigns'],
      },
      user: {
        $extend: ['route.home', 'route.user', 'users.self'],
        Task: { 'read:own': ['*'], 'update:own': ['*'] },
        TaskView: { 'read:own': ['*'] },
      },
      'acme.salesman': {
        $extend: ['user', 'route.home', 'route.salesman', 'route.campaigns', 'localisations.read', 'location.subscriptions'],
        CampaignView: { 'read:own': ['*'], 'create:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] },
        Campaign: { 'create:own': ['*'], 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] },
        CampaignComments: { 'create:own': ['*'], 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] },
        Client: { 'read:own': ['*'] },
      },
      'acme.supersalesman': {
        $extend: ['user', 'route.home', 'route.salesman', 'route.campaigns', 'localisations.read', 'location.subscriptions'],
        CampaignView: { 'read:own': ['*'], 'create:any': ['*'], 'update:any': ['*'], 'delete:own': ['*'] },
        Campaign: { 'create:own': ['*'], 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] },
        CampaignComments: { 'create:own': ['*'], 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] },
        CampaignCommentsInner: { 'create:any': ['*'], 'read:any': ['*'] },
        Offer: { 'read:any': ['*'] },
        Client: { 'read:own': ['*'] },
      },
      'partner.backoffice': {
        $extend: ['user', 'route.home', 'route.salesman', 'route.campaigns', 'localisations.read', 'location.subscriptions'],
        CampaignView: { 'read:own': ['scope:partner'], 'create:own': ['scope:partner'], 'update:own': ['scope:partner'], 'delete:own': ['scope:partner'] },
        Campaign: { 'create:own': ['scope:partner'], 'read:own': ['scope:partner'], 'update:own': ['scope:partner'], 'delete:own': ['scope:partner'] },
        Client: { 'create:any': ['*'], 'read:own': ['*'] },
        CampaignComments: { 'create:own': ['*'], 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] },
        CampaignCommentsInner: { 'create:any': ['*'], 'read:any': ['*'] },
      },
      admin: {
        $extend: ['users.self', 'route.home', 'route.user', 'route.admin'],
        SoftwareVersion: { 'read:any': ['*'], 'create:any': ['*'] },
        configuration: { 'read:any': ['*'], 'update:any': ['*'] },
        users: { 'create:any': ['*'], 'read:any': ['*', '!Password'], 'update:any': ['*'], 'delete:any': ['*'] },
        'user:impersonate': { 'create:any': ['*'] },
      },
      'admin.campaigns': {
        Campaign: { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
        CampaignView: { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
      },
      'users.self': {
        users: { 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] },
        user: { 'read:own': ['*'], 'update:own': ['*'] },
      },
      'users.scoped': {
        users: { 'create:own': ['*'] },
      },
      'localisations.read': {
        Localisation: { 'read:own': ['*'] },
      },
      'location.subscriptions': {
        LocationSubscription: { 'read:own': ['*'], 'create:own': ['*'], 'delete:own': ['*'] },
      },
      'route.home': { RouteHome: { 'read:any': ['*'] } },
      'route.salesman': { RouteSalesman: { 'read:any': ['*'] } },
      'route.user': { RouteUser: { 'read:any': ['*'] } },
      'route.admin': { RouteAdmin: { 'read:any': ['*'] } },
      'route.campaigns': { RouteCampaigns: { 'read:any': ['*'] } },
    },
  },
};
