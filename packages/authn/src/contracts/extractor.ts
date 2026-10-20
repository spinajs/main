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
  /** `req.headers` keys are lower case; `body` is set when the request has one. null: no credentials this extractor reads. */
  abstract extract(req: SignedRequest): Credentials | null;
}
