import type { AuthnContext } from '@spinajs/authn/contracts';
import type { FakeClock } from '../fakes/clock.js';
import type { ConfigOverrides } from '../harness/config.js';
import type { HttpRoutes } from '../harness/http.js';
import type { Harness, Need, PortName } from '../harness/ports.js';
import type { CookieJar } from '../helpers/cookies.js';

export const RULE_IDS = ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15', 'A16', 'A17', 'A18', 'A19', 'A20', 'A21', 'A22', 'A23', 'A24', 'A25', 'A26', 'A27', 'A30', 'A31', 'A32'] as const;
export type RuleId = (typeof RULE_IDS)[number];

export const FACET_KINDS = ['core', 'store', 'http', 'local', 'argon2', 'external', 'step', 'totp', 'token', 'jwt', 'keys', 'jws', 'oidc', 'api', 'identity', 'flow', 'lifecycle', 'boot', 'config', 'migration'] as const;
export type FacetKind = (typeof FACET_KINDS)[number];
export type Facet = `${RuleId}/${FacetKind}`;

const portNames = {
  service: 1,
  seed: 1,
  sessions: 1,
  sessionStorage: 1,
  throttle: 1,
  events: 1,
  sinks: 1,
  logs: 1,
  spy: 1,
  mfa: 1,
  mfaStorage: 1,
  password: 1,
  passwordStore: 1,
  hasher: 1,
  outbox: 1,
  secrets: 1,
  secretStorage: 1,
  tokens: 1,
  keys: 1,
  keyProofs: 1,
  assertion: 1,
  jws: 1,
  links: 1,
  accountLinks: 1,
  external: 1,
  oidc: 1,
  impersonation: 1,
  guard: 1,
  targetGuard: 1,
  roles: 1,
  attributed: 1,
  principals: 1,
  lifecycle: 1,
  metadata: 1,
  identityMeta: 1,
  migration: 1,
  boot: 1,
  actors: 1,
  http: 1,
} satisfies Record<PortName, 1>;
export const PORT_NAMES = Object.keys(portNames) as readonly PortName[];

const routeNames = {
  login: 1,
  logout: 1,
  whoami: 1,
  mfaVerify: 1,
  mfaRecovery: 1,
  mfaEnrol: 1,
  mfaConfirm: 1,
  mfaDisable: 1,
  passwordResetRequest: 1,
  passwordReset: 1,
  passwordChange: 1,
  tokenCreate: 1,
  tokenList: 1,
  sessionsList: 1,
  keyChallenge: 1,
  keyLogin: 1,
  impersonateStart: 1,
  impersonateStop: 1,
  activeRoleSet: 1,
  adminPasswordReset: 1,
  adminMfaReset: 1,
  adminSessionsRevoke: 1,
  adminTokensRevoke: 1,
} satisfies Record<keyof HttpRoutes, 1>;
export const ROUTE_NAMES = Object.keys(routeNames) as readonly (keyof HttpRoutes)[];

export const isNeed = (n: string): n is Need => n === 'fakeDate' || n === 'mfa.recovery' || (PORT_NAMES as readonly string[]).includes(n) || (n.startsWith('http.routes.') && (ROUTE_NAMES as readonly string[]).includes(n.slice('http.routes.'.length)));

export interface PrepareKit {
  readonly clock: FakeClock;
}

export interface Prepared {
  readonly config?: ConfigOverrides;
  readonly data?: unknown;
  close?(): Promise<void>;
}

export interface CaseKit {
  readonly clock: FakeClock;
  ctx(over?: Partial<AuthnContext>): AuthnContext;
  readonly config: ConfigOverrides;
  readonly prepared: Prepared | undefined;
  jar(): CookieJar;
}

export type HarnessWith<N extends Need> = Harness & Required<Pick<Harness, Extract<N, PortName>>>;

export interface AuthnCase<N extends Need = Need> {
  /** The it title: starts with '<id> '; SR cases: '<id> SR-xx <name from plan §3c>'. */
  readonly name: string;
  readonly facet: Facet;
  readonly needs: readonly N[];
  readonly config?: ConfigOverrides | ((p: Prepared | undefined) => ConfigOverrides);
  readonly prepare?: (k: PrepareKit) => Promise<Prepared>;
  readonly timeoutMs?: number;
  run(h: HarnessWith<N>, k: CaseKit): Promise<void>;
}

export interface AuthnRule {
  readonly id: RuleId;
  readonly title: string;
  readonly cases: readonly AuthnCase[];
}

export interface HarnessContext {
  readonly rule: RuleId;
  readonly facet: Facet;
  readonly caseName: string;
  readonly clock: FakeClock;
  /** The case's effective config ({} when none). */
  readonly config: ConfigOverrides;
}

/**
 * Builds a fresh harness per case. Every port shares one container; `dispose` releases what the factory created.
 * Throw `UnsupportedConfig` for a config the lane cannot apply: the case is pending, or fails when claimed.
 */
export type HarnessFactory = (ctx: HarnessContext) => Harness | Promise<Harness>;

export interface TestThis {
  skip(): never;
  timeout(ms: number): void;
  readonly test?: { title: string };
}

/** The mocha BDD globals the kit uses; tests pass a collector instead. */
export interface BddApi {
  describe(title: string, fn: () => void): void;
  it(title: string, fn: (this: TestThis) => Promise<void>): void;
  after(fn: () => void): void;
}

export interface RunOptions {
  /** Facets or whole rules this lane owns: a missing port or UnsupportedConfig there FAILS. */
  readonly claim?: readonly (Facet | RuleId)[];
  /** Register only these facets (others not registered at all). Default: all facets of the ids. */
  readonly facets?: readonly Facet[];
  /** Default true. Without it every case needing 'fakeDate' is pending (fails when claimed). */
  readonly fakeDate?: boolean;
  readonly clockStart?: Date;
  /** Every case gets at least this timeout; cases without their own get exactly this (default 10 s). Raises timing cases too. */
  readonly timeoutMs?: number;
  /** Outer describe, default 'authn behaviour'. */
  readonly title?: string;
  /** @internal tests only */
  readonly bdd?: BddApi;
}

/** Typed constructor so run() sees the needed ports as present. */
export function defineCase<N extends Need>(c: AuthnCase<N>): AuthnCase {
  return c as unknown as AuthnCase;
}

/** One case per row; name and run get the row. */
export function table<R>(rows: readonly R[], make: (row: R) => AuthnCase): AuthnCase[] {
  return rows.map(make);
}

export function defineRule(id: RuleId, title: string, cases: readonly (AuthnCase | readonly AuthnCase[])[]): AuthnRule {
  return Object.freeze({ id, title, cases: Object.freeze(cases.flat() as AuthnCase[]) });
}
