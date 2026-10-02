import type { IdentityRef, KeyChallengeRequest } from '@spinajs/authn/contracts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly cookies?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface HttpResponse {
  readonly status: number;
  /** Lower-case names; repeated headers joined with ', '; set-cookie excluded. */
  readonly headers: Readonly<Record<string, string>>;
  /** Raw Set-Cookie header values. */
  readonly setCookie: readonly string[];
  /** Parsed JSON for a JSON content type, else the text, else undefined. */
  readonly body: unknown;
}

export interface HttpRoutes {
  login(login: string, password: string): HttpRequest;
  logout(): HttpRequest;
  whoami(): HttpRequest;
  mfaVerify(code: string): HttpRequest;
  mfaRecovery(code: string): HttpRequest;
  mfaEnrol(): HttpRequest;
  mfaConfirm(code: string): HttpRequest;
  mfaDisable(code: string): HttpRequest;
  passwordResetRequest(login: string): HttpRequest;
  passwordReset(login: string, secret: string, newPassword: string): HttpRequest;
  passwordChange(oldPassword: string, newPassword: string): HttpRequest;
  tokenCreate(o: { name: string; expiresAt: Date; reauthPassword?: string }): HttpRequest;
  tokenList(): HttpRequest;
  sessionsList(): HttpRequest;
  keyChallenge(req: KeyChallengeRequest): HttpRequest;
  keyLogin(c: { keyId: string; challengeId: string; signature: string }): HttpRequest;
  impersonateStart(target: IdentityRef, password?: string): HttpRequest;
  impersonateStop(): HttpRequest;
  activeRoleSet(role: string, password?: string): HttpRequest;
  adminPasswordReset(target: IdentityRef): HttpRequest;
  adminMfaReset(target: IdentityRef): HttpRequest;
  adminSessionsRevoke(target: IdentityRef): HttpRequest;
  adminTokensRevoke(target: IdentityRef): HttpRequest;
}

export interface HttpPort {
  send(req: HttpRequest): Promise<HttpResponse>;
  /** The app's own origin, e.g. 'https://app.example.test'. */
  readonly origin: string;
  /** The session cookie name under the case env, prefix included. */
  readonly sessionCookie: string;
  /** The remote (socket) address of every request this port sends. */
  readonly socketAddress: string;
  /** Probe route: every method, no policy, answers 200 JSON ProbeBody after all middlewares. */
  readonly probePath: string;
  /** Builders for routes whose body shapes are not frozen; each one optional. */
  readonly routes: Partial<HttpRoutes>;
  /** Top-level body keys that differ per request (request id, timestamp); the kit drops them before comparing failure bodies. Default []. */
  readonly volatileBodyFields?: readonly string[];
}

export interface ProbeBody {
  readonly principal: null | {
    readonly type: string;
    readonly id: string;
    readonly authn?: { method: string; strategy: string; assurance: 'aal1' | 'aal2'; mfa: string[]; authenticatedAt: string; impersonator?: { type: string; id: string }; sessionHandle?: string };
    readonly ceiling?: { roles?: string[]; permissions?: string[]; reason?: string };
    readonly onBehalfOf?: { type: string; id: string };
    readonly delegation?: string;
    readonly attributes?: Record<string, unknown>;
  };
  /** req.storage.ClientIp */
  readonly clientIp: string | null;
  /** Probe handler calls so far in this harness. */
  readonly hits: number;
}
