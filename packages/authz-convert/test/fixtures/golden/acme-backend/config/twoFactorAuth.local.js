// Local env only: an env variable turns 2FA off for debugging.
const enabled = process.env.ACME_TWO_FACTOR_AUTH !== 'false';

export default {
  rbac: {
    twoFactorAuth: { enabled, forceUser: enabled, service: 'Default2FaToken' },
  },
};
