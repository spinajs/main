# `@spinajs/principal`

Principal contracts shared by authentication and authorization: `Principal`, `PrincipalRef`, `ResourceRef`,
`Ceiling`, `AuthnFacts`, the `SYSTEM` and `UNATTENDED` singletons and the `principalKey` and `ceilingHash`
helpers. It has no dependencies, so `@spinajs/authz` builds on it without `@spinajs/authn`.
`@spinajs/authn/contracts` re-exports every name, with the same runtime identity.
