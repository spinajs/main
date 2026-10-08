# Recorded discovery documents

Each file has the shape of a provider's `/.well-known/openid-configuration` as
its documentation and live endpoints publish it (recorded 2026-10). The tenant,
realm and domain are replaced by the test configuration of
`test/presets.test.ts`: Entra tenant `72f988bf-86f1-41af-91ab-2d7cd011db47`,
Keycloak `https://kc.example.test` realm `corp`, Auth0 `corp.eu.auth0.com`,
Okta `corp.okta.com` with authorization server `default`. No keys are
recorded: the tests sign with fake keys served at each document's `jwks_uri`.
GitHub has no discovery document (plain OAuth2).
