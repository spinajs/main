import type { Credentials, SignedRequest } from './credentials.js';

/**
 * Turns a request into credentials. Registered with Array.ofType; AuthnMiddleware asks them in ascending `order` and uses the first non-null
 * answer. Default order (§22.11): signature headers → http-signature; Authorization: Bearer with three parts and typ spinajs-client+jwt →
 * jws-assertion; other three-part values → bearer (JWT); spt_ values → bearer; x-api-key → bearer.
 * Sync: it reads headers only; verification belongs to the strategy, after the throttle (A05).
 */
export abstract class CredentialExtractor {
  /** Lower is asked first. */
  abstract readonly order: number;
  /**
   * `req.headers` keys are lower case; `body` is set when the request has one. null: no credentials this extractor reads.
   *
   * A header the client sent on several lines arrives as one value joined with ", " (RFC 9110 §5.3), as `Signature` and
   * the fields a signature covers may be. `Authorization`, `Proxy-Authorization` and `authn.token.headerName` never
   * arrive repeated: the transports (authn-http, http-socket) refuse such a request before any extractor runs. A
   * credential header of your own is not on that list, so refuse a joined value of it here.
   */
  abstract extract(req: SignedRequest): Credentials | null;
}
