import type { AuthnContext, ExternalSubject, IdentityRef, SessionHandle } from '@spinajs/authn/contracts';
import type { AccountLinkPort } from '../../src/harness/index.js';
import type { ReferenceParts } from './harness.js';

const DEFAULT_MAX_AGE_SECONDS = 300;

/** The identity of an active session that authenticated within the freshness window, else null. */
async function freshIdentity(parts: ReferenceParts, session: SessionHandle, ctx: AuthnContext, maxAgeSeconds: number): Promise<IdentityRef | null> {
  const restored = await parts.sessions.restore(session.id);
  if (!restored || restored.handle.state !== 'active') {
    return null;
  }
  return ctx.now.getTime() - restored.facts.authenticatedAt.getTime() <= maxAgeSeconds * 1000 ? restored.identity : null;
}

/** AccountLinkPort over the reference parts: own fresh session, unique subject, never the last usable credential. */
export function referenceAccountLinks(parts: ReferenceParts, maxAgeSeconds: number = DEFAULT_MAX_AGE_SECONDS): AccountLinkPort {
  return {
    async link(session, external: ExternalSubject, ctx) {
      const identity = await freshIdentity(parts, session, ctx, maxAgeSeconds);
      if (!identity || (await parts.links.find(external.provider, external.subject))) {
        return { ok: false };
      }
      return { ok: true, link: await parts.links.link(identity, external) };
    },
    async unlink(session, linkId, ctx) {
      const identity = await freshIdentity(parts, session, ctx, maxAgeSeconds);
      if (!identity) {
        return { ok: false };
      }
      const own = await parts.links.list(identity);
      const hasPassword = (await parts.passwords.get(identity)) !== null;
      if (!own.some((l) => l.id === linkId) || (!hasPassword && own.length <= 1)) {
        return { ok: false };
      }
      await parts.links.unlink(linkId);
      return { ok: true };
    },
  };
}
