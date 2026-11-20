import { createHash } from 'node:crypto';
import type { AuthorizationModel, AuthzService, IRCompileContext } from '@spinajs/authz';

import { canonicalize } from '../canonical.js';
import type { CombineAlgorithmIR, CombineEntryIR, CombineIR, PolicyIR } from '../ir.js';
import { compileModels } from './merge.js';
import type { IRFragment, MergeConflict } from './merge.js';
import type { PrincipalOptions } from './principal.js';

export type PolicyService = Pick<AuthzService, 'models' | 'irContext'>;

interface CombineEntryLike {
  readonly algorithm: string;
  readonly models?: readonly string[];
}

/** `authz.combine` as the host reads it (`CombineConfig`). */
export interface CombineConfigLike {
  readonly default: CombineEntryLike;
  readonly types?: Readonly<Record<string, CombineEntryLike>>;
}

export interface CompilePolicyOptions {
  readonly combine?: CombineConfigLike;
  /** Fragments no model contributes, such as `ormToIR()`. */
  readonly extra?: readonly IRFragment[];
  /** Default 'opaque': the policy hash covers config-declared policy only (G9). */
  readonly stored?: 'include' | 'opaque';
  readonly principal?: PrincipalOptions;
}

export interface CompiledPolicy {
  readonly ir: PolicyIR;
  /** `canonicalize(ir)`, what `authz_policy_version.ir` stores. */
  readonly canonical: string;
  /** SHA-256 hex of `canonical`. */
  readonly hash: string;
  readonly conflicts: readonly MergeConflict[];
}

const BUILT_IN: ReadonlySet<string> = new Set(['deny-overrides', 'permit-overrides', 'first-applicable']);

const isBuiltIn = (algorithm: string): algorithm is Exclude<CombineAlgorithmIR, { opaque: string }> => BUILT_IN.has(algorithm);

function entryIR(e: CombineEntryLike): CombineEntryIR {
  const algorithm: CombineAlgorithmIR = isBuiltIn(e.algorithm) ? e.algorithm : { opaque: e.algorithm };
  return { algorithm, ...(e.models === undefined ? {} : { models: [...e.models] }) };
}

export function combineFromConfig(combine: CombineConfigLike | undefined): CombineIR | undefined {
  if (combine === undefined) return undefined;
  const types = combine.types === undefined ? undefined : Object.fromEntries(Object.entries(combine.types).map(([t, e]) => [t, entryIR(e)]));
  return { default: entryIR(combine.default), ...(types === undefined ? {} : { types }) };
}

const NO_CONFIG: IRCompileContext = Object.freeze({ config: <T>(_path: string, dflt?: T): T => dflt as T });

/** The domain's policy IR from its booted models, with its canonical text and hash. */
export async function compilePolicy(service: PolicyService, options: CompilePolicyOptions = {}): Promise<CompiledPolicy> {
  const stored = options.stored ?? 'opaque';
  // Called as a method: the host's irContext needs its `this`.
  const context = (m: AuthorizationModel): IRCompileContext => ({ ...(service.irContext?.(m) ?? NO_CONFIG), stored });
  const combine = combineFromConfig(options.combine);
  const { ir, conflicts } = await compileModels(service.models(), context, options.extra ?? [], { ...(combine ? { combine } : {}), ...(options.principal ? { principal: options.principal } : {}) });
  const canonical = canonicalize(ir);
  return { ir, canonical, hash: createHash('sha256').update(canonical).digest('hex'), conflicts };
}
