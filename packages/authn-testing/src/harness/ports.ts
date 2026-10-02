import type { KeyObject } from 'node:crypto';
import type {
  AuthnContext,
  AuthnEvent,
  AuthnService,
  AuthnThrottle,
  AuthenticationStrategy,
  Credentials,
  ExternalSubject,
  IdentityLink,
  IdentityLinkStore,
  IdentityRef,
  IdentityStatus,
  JwsSigner,
  JwsVerifier,
  KeyAlgorithm,
  KeyChallenge,
  KeyOwner,
  KeyRegistry,
  MfaStep,
  PasswordCredentialStore,
  PasswordService,
  Principal,
  PublicJwk,
  SecretStore,
  SessionHandle,
  SessionIssuer,
  TokenService,
} from '@spinajs/authn/contracts';
import type { PrincipalOfCall } from '../fakes/principals.js';
import type { ConfigOverrides, AppEnv } from './config.js';
import type { HttpPort, HttpRoutes } from './http.js';

type StatusFlags = Partial<Omit<IdentityStatus, 'exists'>>;

export interface Harness {
  readonly service?: AuthnService;
  readonly seed?: SeedPort;
  readonly sessions?: SessionIssuer;
  readonly sessionStorage?: SessionStoragePort;
  readonly throttle?: ThrottlePort;
  readonly events?: EventsPort;
  /** At least two sinks registered with Array.ofType (A21). */
  readonly sinks?: readonly EventsPort[];
  readonly logs?: LogsPort;
  readonly spy?: VerifySpyPort;
  readonly mfa?: MfaPort;
  readonly mfaStorage?: MfaStoragePort;
  readonly password?: PasswordService;
  readonly passwordStore?: PasswordCredentialStore;
  readonly hasher?: HasherPort;
  readonly outbox?: OutboxPort;
  readonly secrets?: SecretStore;
  readonly secretStorage?: SecretStoragePort;
  readonly tokens?: TokenService;
  readonly keys?: KeyRegistry;
  readonly keyProofs?: KeyProofPort;
  readonly assertion?: AssertionPort;
  readonly jws?: JwsPort;
  readonly links?: IdentityLinkStore;
  readonly accountLinks?: AccountLinkPort;
  readonly external?: ExternalPort;
  readonly oidc?: OidcPort;
  readonly impersonation?: ImpersonationPort;
  /** The ImpersonationGuard the lane uses (A09, A20). */
  readonly guard?: GuardPort;
  /** Whatever enforces A25's target rule in the lane. */
  readonly targetGuard?: GuardPort;
  readonly roles?: RolesPort;
  /** A23 attribute cases. */
  readonly attributed?: AttributedPort;
  readonly principals?: PrincipalsPort;
  readonly lifecycle?: LifecyclePort;
  readonly metadata?: MetadataPort;
  readonly identityMeta?: IdentityMetaPort;
  readonly migration?: MigrationPort;
  readonly boot?: BootPort;
  readonly actors?: ActorsPort;
  readonly http?: HttpPort;
  dispose?(): Promise<void>;
}

export type PortName = Exclude<keyof Harness, 'dispose'>;

/**
 * A port; 'fakeDate' (the clock is installed); 'mfa.recovery' (h.mfa.step has verifyRecovery and
 * regenerateRecoveryCodes as functions); or a route builder 'http.routes.<name>'.
 */
export type Need = PortName | 'fakeDate' | 'mfa.recovery' | `http.routes.${keyof HttpRoutes}`;

export interface GuardPort {
  allowAll(): Promise<void>;
  /** Later checks for `target` (every target when omitted) answer { ok: false, code }. */
  deny(code: 'forbidden' | 'protected_role' | 'escalation', target?: IdentityRef): Promise<void>;
}

export interface RolesPort {
  /** The roles RoleSource gives every principal of `id`. */
  grant(id: IdentityRef, roles: readonly { role: string; requirePassword: boolean }[]): Promise<void>;
}

/** The lane registers strategies that return identity `id` with StrategyOutcome.attributes = KIT_ATTRIBUTES ({ profile: 'kit-p' }); FakeStrategy with a custom verify does it. */
export interface AttributedPort {
  credentials(mode: 'interactive' | 'per-request', id: IdentityRef): Promise<Credentials>;
}

export interface SeedPort {
  /** An identity the lane's IdentityStore finds by login (and email); password stored through the lane's own hashing. */
  user(spec: { login: string; email?: string; password?: string; status?: StatusFlags }): Promise<IdentityRef>;
  /** Flags only: no revocation or other side effect. */
  setStatus(id: IdentityRef, status: StatusFlags): Promise<void>;
}

export interface SessionStoragePort {
  /** Every storage key (ISession.SessionId) the lane's store holds, live or not yet swept. */
  storedKeys(): Promise<readonly string[]>;
  /** A 2.x-shaped row: SessionId = rawId (uuid v4), Data User = user (users.Uuid), Authorized, Impersonator. */
  seedLegacy(row: { rawId: string; user: string; authorized: boolean; creation: Date; impersonator?: string }): Promise<void>;
}

export interface BackoffParams {
  readonly free: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface FlowParams {
  readonly account?: BackoffParams;
  readonly ip?: BackoffParams;
}

export interface ThrottleParams {
  readonly login: FlowParams;
  readonly mfa: FlowParams;
  readonly reset: FlowParams;
  readonly reauth: FlowParams;
  readonly resetAfterSeconds: number;
  readonly global?: BackoffParams | null;
}

/** params: what the lane configured after applying HarnessContext.config (equal to DEFAULT_THROTTLE without overrides). */
export interface ThrottlePort {
  readonly throttle: AuthnThrottle;
  readonly params: ThrottleParams;
}

export interface EventsPort {
  all(): readonly AuthnEvent[];
  clear(): void;
}

/** What the log audit sink wrote, one entry per line. */
export interface LogsPort {
  lines(): readonly string[];
}

/** AuthenticationStrategy.verify calls so far, all strategies. */
export interface VerifySpyPort {
  verifyCalls(): number;
}

export interface MfaPort {
  readonly step: MfaStep;
  /** Enrols id in step.name so MfaPolicy requires it. */
  enrol(id: IdentityRef): Promise<void>;
  /** A code step.verify accepts now; may equal an earlier one inside one time step. */
  code(id: IdentityRef): Promise<string>;
  /** Codes that confirmEnrolment returned, when the step issues them. */
  recoveryCodes?(id: IdentityRef): Promise<readonly string[]>;
}

export interface MfaStoragePort {
  storedSecret(id: IdentityRef): Promise<string | null>;
  storedRecoveryCodes(id: IdentityRef): Promise<readonly string[]>;
}

export interface HasherPort {
  hash(password: string): Promise<string>;
  /** A hash under other parameters or another pepper; argon2 omitted: library defaults; pepper null: none. */
  hashWith(password: string, opts: { argon2?: { memoryCost: number; timeCost: number; parallelism: number }; pepper?: { secret: string; version: number } | null }): Promise<string>;
  /** Highest number of argon2 operations seen running at once since the harness was built. */
  peakConcurrent(): number;
}

export interface OutboxPort {
  /** The raw secret of the newest mail of that purpose to that identity, or null. */
  secretFor(id: IdentityRef, purpose: 'reset' | 'invite'): Promise<string | null>;
}

export interface SecretStoragePort {
  rows(): Promise<readonly { identity: IdentityRef; purpose: string; hash: string; expiresAt: Date; usedAt?: Date | null }[]>;
}

export interface KitKeyPair {
  readonly alg: KeyAlgorithm;
  readonly publicJwk: PublicJwk;
  readonly privateKey: KeyObject;
  /** RFC 7638 thumbprint. */
  readonly kid: string;
}

export interface KeyProofPort {
  /** The lane's signature format over a challenge (domain separated by purpose). */
  sign(challenge: KeyChallenge, purpose: 'register' | 'login', key: KitKeyPair): Promise<string>;
}

export interface AssertionPort {
  readonly audience: string;
  issuerOf(owner: KeyOwner): string;
}

export interface JwsPort {
  readonly verifier: JwsVerifier;
  readonly signer?: JwsSigner;
}

export interface AccountLinkPort {
  link(session: SessionHandle, external: ExternalSubject, ctx: AuthnContext): Promise<{ ok: true; link: IdentityLink } | { ok: false }>;
  unlink(session: SessionHandle, linkId: string, ctx: AuthnContext): Promise<{ ok: boolean }>;
}

export interface ExternalPort {
  readonly provider: string;
  credentialsFor(subject: ExternalSubject): Promise<Credentials>;
}

export type IdTokenTamper = 'none' | 'wrong-iss' | 'wrong-aud' | 'azp-mismatch' | 'wrong-nonce' | 'expired' | 'iat-future' | 'alg-none' | 'hmac-public-key' | 'at-hash-mismatch';

export interface OidcPort {
  /** The :provider route segment. */
  readonly provider: string;
  /** The `provider` value the lane stores in IdentityLink rows for this provider (e.g. 'oidc:<name>'). */
  readonly linkProvider: string;
  /** Plays the fake IdP for the authorization request at `location`: authenticates `subject`, signs the ID token with `tamper`, and returns the callback query (code, state). */
  authorize(location: string, subject: ExternalSubject, tamper?: IdTokenTamper): Promise<Readonly<Record<string, string>>>;
}

export interface ImpersonationPort {
  start(session: SessionHandle, target: IdentityRef, ctx: AuthnContext, reauth?: Credentials): Promise<{ ok: true; session: SessionHandle } | { ok: false }>;
  stop(session: SessionHandle, ctx: AuthnContext): Promise<SessionHandle | null>;
  /** What the next request with this session resolves to (SessionPrincipalResolver plus the impersonation checks), or null. */
  principalOf(session: SessionHandle, ctx: AuthnContext): Promise<Principal | null>;
}

export interface PrincipalsPort {
  calls(): readonly PrincipalOfCall[];
}

export interface LifecyclePort {
  ban(id: IdentityRef): Promise<void>;
  deactivate(id: IdentityRef): Promise<void>;
}

export type MetadataActor = 'owner' | 'admin';

export interface MetadataPort {
  /** Writes through the lane's guard-free internal path (the 2.x writer); returns the row id. */
  seedRaw(id: IdentityRef, key: string, value: unknown): Promise<string>;
  rawKeys(id: IdentityRef): Promise<readonly string[]>;
  write(as: MetadataActor, id: IdentityRef, key: string, value: unknown): Promise<{ ok: boolean }>;
  read(as: MetadataActor, id: IdentityRef, key: string): Promise<{ found: boolean; value?: unknown }>;
  list(as: MetadataActor, id: IdentityRef): Promise<readonly string[]>;
  updateById(as: MetadataActor, id: IdentityRef, rowId: string, value: unknown): Promise<{ ok: boolean }>;
  deleteById(as: MetadataActor, id: IdentityRef, rowId: string): Promise<{ ok: boolean }>;
}

/**
 * users' public metadata write action, the one apps call (today the exported `setUserMeta`), not the internal
 * writer users' own lifecycle code uses for `user:ban:` and `user:invite:` keys.
 */
export interface IdentityMetaPort {
  set(id: IdentityRef, key: string, value: unknown): Promise<{ ok: boolean }>;
}

export interface LegacyMetadataRow {
  readonly Key: string;
  readonly Type: 'number' | 'float' | 'string' | 'json' | 'boolean' | 'datetime';
  readonly Value: string | null;
}

export interface LegacyUser {
  readonly Uuid: string;
  readonly Email: string;
  readonly Login: string;
  readonly IsActive: boolean;
  readonly metadata: readonly LegacyMetadataRow[];
}

export interface SecretRowView {
  readonly identity: string;
  readonly purpose: string;
  readonly secret_hash: string;
  readonly expires_at: Date;
  readonly created_at: Date;
  readonly used_at: Date | null;
}

export interface MigrationPort {
  /** Users and users_metadata rows exactly as given. */
  seedLegacy(users: readonly LegacyUser[]): Promise<void>;
  /** AuthnFromUserMetadata up(). */
  run(): Promise<void>;
  /** authn_secret rows. */
  secretRows(): Promise<readonly SecretRowView[]>;
  metadataKeys(uuid: string): Promise<readonly string[]>;
}

/** 'public' exists only for the cookie secret: the shipped `http.cookie.secret` default. Pepper and MFA key ship null, so they have no public value. */
export interface BootSpec {
  readonly env?: AppEnv;
  readonly config?: ConfigOverrides;
  readonly strategies?: readonly { readonly name: string; readonly service: string; readonly instance?: AuthenticationStrategy; readonly listed: boolean }[];
  readonly secrets?: { readonly cookie?: 'strong' | 'public' | 'missing'; readonly pepper?: 'strong' | 'off'; readonly mfaKey?: 'strong' | 'missing' };
  /** 'secret-storing': one MFA step that stores secrets is configured (the lane's TOTP step, or a fake declaring it stores secrets); 'none': no such step. Default 'none'. */
  readonly mfaStep?: 'secret-storing' | 'none';
}

export type BootResult = { readonly ok: true; readonly service: AuthnService; dispose(): Promise<void> } | { readonly ok: false; readonly error: unknown };

export interface CheckFinding {
  readonly topic: 'strategies' | 'secrets' | 'proxy' | 'cors' | (string & {});
  readonly level: 'error' | 'warning';
  readonly message: string;
}

export interface BootPort {
  /** A fresh app boot: registers `instance` under `service` when given (else the lane's own class of that name), lists `listed` ones in authn.strategies, applies env, secrets ('strong': a random 32-byte value; 'public': the shipped default; 'missing': unset; 'off': explicitly null) and mfaStep. */
  start(spec: BootSpec): Promise<BootResult>;
  /** authn:check-config against that configuration, mapped to topics. */
  checkConfig(spec: BootSpec): Promise<readonly CheckFinding[]>;
}

export interface ActorsPort {
  admin(opts: { credentialsRight: boolean }): Promise<{ ref: IdentityRef; login: string; password: string }>;
}
