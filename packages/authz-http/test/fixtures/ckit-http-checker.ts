/**
 * The body ckit's createHttpChecker puts on the wire (its default `encodeChecks`, then
 * `JSON.stringify`) for the requests of coderush/ckit `packages/access/src/http.test.ts`,
 * "createHttpChecker: the default exchange > posts the checks as JSON and returns the answers in
 * request order". Keep it byte for byte: it is the compatibility contract (design §10.7).
 */
export const CKIT_DEFAULT_EXCHANGE_BODY =
  '{"checks":[{"object":{"type":"doc","id":"1"},"permission":"edit","subject":{"type":"user","id":"me"}},{"object":{"type":"doc","id":"2"},"permission":"view","subject":{"type":"user","id":"me"},"context":{"ip":"10.0.0.1"}},{"object":{"type":"doc","id":"3"},"permission":"edit","subject":{"type":"user","id":"me"}}]}';

/** That test's fake backend allows odd ids, which the domain of access-controller.test.ts mirrors. */
export const CKIT_DEFAULT_EXCHANGE_RESULTS: readonly boolean[] = [true, false, true];
