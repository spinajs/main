import type { AuthnContext, Credentials, ExternalSubject, IdentityLink, SessionHandle } from '@spinajs/authn/contracts';

export type OidcLinkResult = { readonly ok: true; readonly link: IdentityLink } | { readonly ok: false };

/**
 * Explicit linking and unlinking (A19, design §22.12), with the signatures of N1's AccountLinkService, which enforces
 * the rules: the identity's own active session with fresh auth, `purpose: 'link'`, a subject linked elsewhere refused,
 * and never the last usable credential removed. authn-oidc only proves the caller controls the external subject (the
 * link flow's callback). Without a registration the link routes answer 404.
 */
export abstract class OidcAccountLinks {
  /** `reauth`: an inline re-authentication when the session is not fresh (N1's optional argument). */
  abstract link(session: SessionHandle, external: ExternalSubject, ctx: AuthnContext, reauth?: Credentials): Promise<OidcLinkResult>;
  abstract unlink(session: SessionHandle, linkId: string, ctx: AuthnContext, reauth?: Credentials): Promise<{ readonly ok: boolean }>;
}
