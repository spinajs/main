
import _ from 'lodash';

import { analyze } from './analyze.js';
import type { DbFacts, SourceFacts } from './facts.js';
import { configModule, warningsMarkdown } from './emit.js';
import { ConversionError, Findings } from './findings.js';
import type { Finding } from './findings.js';
import { DEFAULT_SELF_RESOURCES, convertGrants } from './grants.js';
import type { RoleOut } from './grants.js';
import { SCALAR_TO_ARRAY_KEYS, convertKeys } from './keys.js';
import { RBAC_2X_DEFAULTS } from './legacy.js';
import type { KeyOutput } from './keys.js';
import { loadLayers } from './load.js';
import type { ConfigLayers } from './load.js';
import { getPath, isPlain, setPath } from './values.js';
import type { Plain } from './values.js';

export interface ConvertOptions {
  /** Compiled config dirs of the app, merged in this order. */
  readonly dirs: readonly string[];
  readonly db?: DbFacts;
  readonly src?: SourceFacts;
  /** Resources whose :own grants mean the caller's own account (relation 'self'). */
  readonly selfResources?: readonly string[];
}

export interface OutputFile {
  readonly name: string;
  readonly content: string;
}

export interface ConvertResult {
  readonly files: readonly OutputFile[];
  readonly findings: readonly Finding[];
  /** 0: done; 2: done with keys left for a person (`manual` findings). */
  readonly exitCode: 0 | 2;
}

export const WARNINGS_FILE = 'authz-warnings.md';

// The 3.0 loader reads `name.js` as common and `name.<env>.js` per env, so the base name must hold no dot.
export const outputName = (root: string, layer: string): string => (layer === 'common' ? `${root}-generated.ts` : `${root}-generated.${layer}.ts`);

const ROOTS = ['authz', 'users', 'authn'] as const;
type Root = (typeof ROOTS)[number];

interface LayerOutput {
  readonly name: string;
  readonly out: KeyOutput;
  readonly findings: Findings;
}

function grantedRoles(view: Plain): Set<string> {
  const g = getPath(view, ['rbac', 'grants']);
  return new Set(isPlain(g) ? Object.keys(g) : []);
}

function convertLayer(name: string, layer: Plain, merged: Plain, selfResources: readonly string[], common?: Plain): LayerOutput {
  const f = new Findings(name);
  const rbac = isPlain(layer.rbac) ? layer.rbac : {};
  const grants = convertGrants(rbac, { selfResources }, f, { granted: grantedRoles(merged) });
  const out = convertKeys(layer, merged, f, common);
  if (grants.roles.size > 0) setPath(out.authz, ['authz', 'rbac', 'roles'], Object.fromEntries([...grants.roles].map(([n, r]) => [n, roleLiteral(r)])));
  if (grants.permissions.size > 0) {
    // Merged with the permissions packages declare; `fields: true` only where a grant carries fields.
    setPath(out.authz, ['authz', 'permissions'], Object.fromEntries([...grants.permissions].map(([p, d]) => [p, d.fields ? { fields: true } : {}])));
  }
  return { name, out, findings: f };
}

function roleLiteral(r: RoleOut): Plain {
  return {
    ...(r.description === undefined ? {} : { description: r.description }),
    ...(r.extends === undefined ? {} : { extends: r.extends }),
    ...(r.assignable === undefined ? {} : { assignable: r.assignable }),
    grants: r.grants,
  };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** With DB facts: roles no user or token holds and that only serve as `$extend` targets become `assignable: false`. */
function markAssignable(layers: LayerOutput[], views: Plain[], db: DbFacts, f: Findings): void {
  const held = new Set([...db.users, ...db.tokens].flatMap((r) => r.roles));
  const extended = new Set<string>();
  const declared = new Set<string>();
  const implicit = new Set<string>(['guest']);
  for (const view of views) {
    const grants = getPath(view, ['rbac', 'grants']);
    for (const d of isPlain(grants) ? Object.values(grants).filter(isPlain) : []) for (const r of strings(d.$extend)) extended.add(r);
    const roles = getPath(view, ['rbac', 'roles']);
    for (const r of Array.isArray(roles) ? roles : []) if (isPlain(r) && typeof r.Name === 'string') declared.add(r.Name);
    const dr = getPath(view, ['rbac', 'defaultRole']);
    if (typeof dr === 'string') implicit.add(dr);
  }
  const marked: string[] = [];
  for (const layer of layers) {
    const roles = getPath(layer.out.authz, ['authz', 'rbac', 'roles']);
    if (!isPlain(roles)) continue;
    for (const [name, def] of Object.entries(roles)) {
      if (held.has(name) || !extended.has(name) || declared.has(name) || implicit.has(name) || !isPlain(def)) continue;
      roles[name] = { ...(def.description === undefined ? {} : { description: def.description }), ...(def.extends === undefined ? {} : { extends: def.extends }), assignable: false, grants: def.grants };
      marked.push(name);
    }
  }
  if (marked.length > 0) f.info('assignable', `No user or token holds ${[...new Set(marked)].map((r) => `'${r}'`).join(', ')} and other roles extend them, so they are written 'assignable: false'.`);
}

/**
 * 2.x merges the layers before it reads an attribute list, so a list set in common and in an env file is one
 * list there; converted one layer at a time it would become two grants that may give more (a negation in one
 * part, a scope token in the other). Refused.
 */
function sharedGrantKeys(common: Plain, env: Plain, name: string, f: Findings): void {
  const c = getPath(common, ['rbac', 'grants']);
  const e = getPath(env, ['rbac', 'grants']);
  if (!isPlain(c) || !isPlain(e)) return;
  for (const [role, def] of Object.entries(e)) {
    const base = c[role];
    if (!isPlain(def) || !isPlain(base)) continue;
    for (const [resource, actions] of Object.entries(def)) {
      if (resource === '$extend' || !isPlain(actions) || !isPlain(base[resource])) continue;
      for (const key of Object.keys(actions)) {
        if (key in (base[resource] as Plain)) {
          f.refuse(`rbac.grants['${role}']['${resource}']['${key}'] is set in common and in env '${name}'; 2.x joins the two attribute lists before it reads them, which separate files cannot express. Move the key into one layer`);
        }
      }
    }
  }
}

/**
 * 2.x logged in through @spinajs/rbac's SimpleDbAuthProvider unless rbac.auth.service said otherwise, and no
 * 3.0 package lists a strategy, so the first layer with rbac keys gets the local strategy when its view leaves
 * rbac.auth out. An env file cannot take it back (arrays concatenate), so an env that names another provider
 * is left for a person.
 */
function defaultStrategy(layers: ConfigLayers, outputs: LayerOutput[]): void {
  const LOCAL = [{ name: 'local', service: 'LocalPasswordStrategy' }];
  const DEFAULT = String(RBAC_2X_DEFAULTS['auth.service']);
  // The provider 2.x logged in with in a view; undefined where the view has no rbac keys at all.
  const effective = (view: Plain) => (isPlain(view.rbac) ? String(getPath(view, ['rbac', 'auth', 'service']) ?? DEFAULT) : undefined);
  const unset = (view: Plain) => isPlain(view.rbac) && getPath(view, ['rbac', 'auth', 'service']) === undefined;
  const [common, ...envs] = outputs;
  const base = effective(layers.view(null));
  if (base !== undefined && unset(layers.view(null))) setPath(common.out.authn, ['authn', 'strategies'], LOCAL);
  for (const o of envs) {
    const view = layers.view(o.name);
    if (base === undefined) {
      if (unset(view) && getPath(o.out.authn, ['authn', 'strategies']) === undefined) setPath(o.out.authn, ['authn', 'strategies'], LOCAL);
      continue;
    }
    const mine = effective(view);
    if (mine !== base) {
      o.findings.manual(
        'env-array',
        `2.x logged in with '${mine}' in env '${o.name}' and with '${base}' in common. authn.strategies concatenates across config files, so an env file cannot replace the common strategy; split authn.strategies by hand, or the env keeps both logins.`,
        'rbac.auth.service',
      );
    }
  }
}

/** Converts the app's 2.x config dirs. Throws ConversionError, and returns no file, when any layer holds something it refuses. */
export async function convert(opts: ConvertOptions): Promise<ConvertResult> {
  return convertLayers(await loadLayers(opts.dirs), opts);
}

export function convertLayers(layers: ConfigLayers, opts: Omit<ConvertOptions, 'dirs'> & { dirs?: readonly string[] }): ConvertResult {
  const selfResources = opts.selfResources ?? DEFAULT_SELF_RESOURCES;
  const outputs: LayerOutput[] = [convertLayer('common', layers.common, layers.view(null), selfResources)];
  for (const [env, layer] of layers.envs) {
    const out = convertLayer(env, layer, layers.view(env), selfResources, layers.view(null));
    sharedGrantKeys(layers.common, layer, env, out.findings);
    outputs.push(out);
  }

  const problems = outputs.flatMap((o) => o.findings.problems);
  if (problems.length > 0) throw new ConversionError(problems);

  const common = outputs[0];
  defaultStrategy(layers, outputs);
  for (const o of outputs.slice(1)) {
    for (const k of SCALAR_TO_ARRAY_KEYS) {
      const p = k.split('.');
      const root = o.out[p[0] as Root];
      const mine = getPath(root, p);
      const base = getPath(common.out[p[0] as Root], p);
      if (base !== undefined && o.out.cleared.includes(k)) {
        o.findings.manual('env-array', `Env '${o.name}' turns off what ${k} holds in common; config files concatenate arrays, so the env file cannot empty it. Split the key by hand.`, k);
      }
      if (mine === undefined || base === undefined) continue;
      if (!_.isEqual(mine, base)) {
        o.findings.manual('env-array', `${k} differs in common and in env '${o.name}'; config files concatenate arrays, so the env file cannot replace the common value. Split the key by hand.`, k);
      }
      // Equal to common it adds nothing; written twice it would be listed twice.
      for (let n = p.length; n > 0; n--) {
        const parent = getPath(root, p.slice(0, n - 1)) as Plain;
        if (n === p.length || Object.keys(parent[p[n - 1]] as Plain).length === 0) delete parent[p[n - 1]];
      }
    }
  }

  const tail = new Findings();
  for (const s of layers.skipped) tail.warn('file-skipped', `Not converted: ${s}.`);
  if (outputs.some((o) => getPath(o.out.authn, ['authn', 'mfa', 'steps']) !== undefined)) {
    tail.warn('mfa-key', 'TOTP secrets are stored encrypted in 3.0: set authn.mfa.encryptionKey (a secret reference) before running the migrations, which refuse to run without it.', 'authn.mfa.encryptionKey');
  }
  for (const [layer, paths] of layers.computed) {
    const read = paths.filter((p) => p.startsWith('rbac.') || p.startsWith('http.'));
    const at = new Findings(layer);
    for (const p of read) {
      at.manual('computed-value', `${p} changed when the config ran under another NODE_ENV; the converted value is the one of this run. Set the 3.0 key per env by hand.`, p);
    }
    tail.list.push(...at.list);
  }
  for (const { file, layer, vars } of layers.envReaders) {
    const at = new Findings(layer);
    at.warn('reads-env', `${file} (or a module it imports) reads ${vars.join(', ')} from the environment; values derived from them were converted as this run saw them. Check the keys it sets.`);
    tail.list.push(...at.list);
  }
  for (const e of layers.probeErrors) {
    tail.manual('probe-failed', `The converter ran the config files a second time, under the other NODE_ENV, to find values they compute; that run failed, so no such value was found: ${e}`);
  }
  if (opts.db) markAssignable(outputs, [layers.view(null), ...[...layers.envs.keys()].map((e) => layers.view(e))], opts.db, tail);

  const analyses: Finding[] = [];
  const commonAnalysis = analyze(layers.view(null), 'common', { selfResources, db: opts.db, src: opts.src }).list;
  analyses.push(...commonAnalysis);
  const seen = new Set(commonAnalysis.map((x) => `${x.code}|${x.path ?? ''}|${x.message}`));
  for (const env of layers.envs.keys()) {
    for (const x of analyze(layers.view(env), env, { selfResources, db: opts.db, src: opts.src }).list) {
      if (!seen.has(`${x.code}|${x.path ?? ''}|${x.message}`)) analyses.push(x);
    }
  }

  const findings = [...outputs.flatMap((o) => o.findings.list), ...tail.list, ...analyses];
  const sources = opts.dirs?.join(', ') ?? 'the given config';
  const header = (layer: string) => [
    `Generated by spinajs-authz-convert from ${sources} (${layer === 'common' ? 'common files' : `env '${layer}' files`}).`,
    `Read ${WARNINGS_FILE} before you use it.`,
  ];
  const files: OutputFile[] = [];
  for (const o of outputs) {
    for (const root of ROOTS) {
      const value = o.out[root];
      if (Object.keys(value).length === 0) continue;
      files.push({ name: outputName(root, o.name), content: configModule(value, header(o.name)) });
    }
  }
  files.push({
    name: WARNINGS_FILE,
    content: warningsMarkdown(findings, [
      `Inputs: ${sources}; layers: common${[...layers.envs.keys()].map((e) => `, ${e}`).join('')}.`,
      'The converter ran the config files, so a value a file computes (from process.env, the clock, …) is written as the value it had during the run. Check such keys by hand.',
    ]),
  });
  return { files, findings, exitCode: findings.some((x) => x.severity === 'manual') ? 2 : 0 };
}
