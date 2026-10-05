// Adapted from contracts/ts/server-api/src/fixtures.ts at coderush/canvas 1803e0c
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ADDONS, type Addon, type Capability, isCapability, isRole, ORG_ROLES, type OrgRole, type Role, ROLES } from "./c6/access.js";
import type { AgentScope, Decision, DenyReason, PolicyRule, Principal, Resource } from "./c6/authz.js";
import {
  type AccessState,
  type BranchRule,
  DEFAULT_ORG_POLICIES,
  type Grant,
  type Grantee,
  type OrgPolicies,
} from "./c6/state.js";

export interface AuthzCase {
  name: string;
  principal: Principal;
  capability: Capability;
  resource: Resource;
  expected: Decision;
}

export interface AuthzFixtures {
  /** Fixture symbol (`"ED"`, `"WEB"`) to UUID. */
  ids: ReadonlyMap<string, string>;
  state: AccessState;
  cases: AuthzCase[];
}

type Json = Record<string, unknown>;

export class FixtureError extends Error {}

function obj(value: unknown, path: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FixtureError(`${path}: expected object`);
  return value as Json;
}

function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new FixtureError(`${path}: expected array`);
  return value;
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") throw new FixtureError(`${path}: expected string`);
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new FixtureError(`${path}: expected boolean`);
  return value;
}

function role(value: unknown, path: string): Role {
  if (!isRole(value)) throw new FixtureError(`${path}: unknown role ${JSON.stringify(value)}`);
  return value;
}

/** S3's tables hold fewer roles for file grants and links (access design §1, "Tables"). */
const FILE_GRANT_ROLES: readonly Role[] = ["viewer", "commenter", "editor"];
const LINK_ROLES: readonly Role[] = ["viewer", "commenter"];

function roleIn(allowed: readonly Role[], value: unknown, path: string): Role {
  const r = role(value, path);
  if (!allowed.includes(r)) throw new FixtureError(`${path}: role ${JSON.stringify(r)} not allowed, expected one of ${allowed.join(", ")}`);
  return r;
}

function addons(value: unknown, path: string): Addon[] {
  return arr(value, path).map((a, i) => {
    if (!(ADDONS as readonly unknown[]).includes(a)) throw new FixtureError(`${path}/${i}: unknown add-on`);
    return a as Addon;
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POLICY_RULES: readonly PolicyRule[] = ["no_download", "editors_may_not_invite", "delete_needs_org_admin"];

function onlyKeys(o: Json, keys: readonly string[], path: string): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new FixtureError(`${path}/${k}: unexpected field`);
}

function field(o: Json, key: string, path: string): unknown {
  if (!(key in o)) throw new FixtureError(`${path}/${key}: missing field`);
  return o[key];
}

function policies(value: unknown, path: string): OrgPolicies {
  const given = obj(value, path);
  const out: Record<string, boolean | Role> = { ...DEFAULT_ORG_POLICIES };
  for (const [key, v] of Object.entries(given)) {
    const dflt = (DEFAULT_ORG_POLICIES as Record<string, unknown>)[key];
    if (dflt === undefined) throw new FixtureError(`${path}/${key}: unknown policy`);
    out[key] = typeof dflt === "boolean" ? bool(v, `${path}/${key}`) : role(v, `${path}/${key}`);
  }
  return out as unknown as OrgPolicies;
}

function denyReason(value: unknown, path: string): DenyReason {
  const r = obj(value, path);
  const code = str(field(r, "code", path), `${path}/code`);
  const exact = (extra: readonly string[]) => onlyKeys(r, ["code", ...extra], path);
  switch (code) {
    case "role_too_low":
      exact(["role", "needed"]);
      return { code, role: role(field(r, "role", path), `${path}/role`), needed: role(field(r, "needed", path), `${path}/needed`) };
    case "addon_missing": {
      exact(["addon"]);
      const addon = field(r, "addon", path);
      if (!(ADDONS as readonly unknown[]).includes(addon)) throw new FixtureError(`${path}/addon: unknown add-on`);
      return { code, addon: addon as Addon };
    }
    case "policy": {
      exact(["rule"]);
      const rule = field(r, "rule", path);
      if (!(POLICY_RULES as readonly unknown[]).includes(rule)) throw new FixtureError(`${path}/rule: unknown policy rule`);
      return { code, rule: rule as PolicyRule };
    }
    case "branch_protected":
      exact(["pattern", "needed"]);
      return { code, pattern: str(field(r, "pattern", path), `${path}/pattern`), needed: role(field(r, "needed", path), `${path}/needed`) };
    case "unknown_resource":
    case "no_access":
    case "file_only":
    case "org_role_needed":
    case "agents_disabled":
    case "out_of_scope":
    case "link_invalid":
      exact([]);
      return { code };
    default:
      throw new FixtureError(`${path}/code: unknown deny code ${JSON.stringify(code)}`);
  }
}

function decision(value: unknown, path: string): Decision {
  const d = obj(value, path);
  if (bool(field(d, "allowed", path), `${path}/allowed`)) {
    onlyKeys(d, ["allowed", "role"], path);
    return { allowed: true, role: role(field(d, "role", path), `${path}/role`) };
  }
  onlyKeys(d, ["allowed", "reason"], path);
  return { allowed: false, reason: denyReason(field(d, "reason", path), `${path}/reason`) };
}

/**
 * Turns the symbolic fixture files into UUID-keyed data. Every id field
 * names a key of `state.ids`; other strings (branch names, patterns) stay.
 */
export function resolveAuthzFixtures(stateJson: unknown, casesJson: unknown): AuthzFixtures {
  const root = obj(stateJson, "state");
  const ids = new Map<string, string>();
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(obj(root["ids"], "state/ids"))) {
    const uuid = str(v, `state/ids/${k}`);
    if (!UUID.test(uuid)) throw new FixtureError(`state/ids/${k}: expected a lowercase UUID`);
    if (seen.has(uuid)) throw new FixtureError(`state/ids/${k}: duplicate UUID`);
    seen.add(uuid);
    ids.set(k, uuid);
  }
  const id = (value: unknown, path: string): string => {
    const uuid = ids.get(str(value, path));
    if (uuid === undefined) throw new FixtureError(`${path}: unknown fixture id ${JSON.stringify(value)}`);
    return uuid;
  };
  const optId = (value: unknown, path: string): string | null => (value === null ? null : id(value, path));
  const entries = (value: unknown, path: string) =>
    Object.entries(obj(value, path)).map(([k, v]) => [id(k, `${path}/${k}`), obj(v, `${path}/${k}`), `${path}/${k}`] as const);
  const grantee = (value: unknown, path: string): Grantee => {
    const g = obj(value, path);
    const kind = str(g["kind"], `${path}/kind`);
    if (kind !== "user" && kind !== "group") throw new FixtureError(`${path}/kind: expected user or group`);
    return { kind, id: id(g["id"], `${path}/id`) };
  };
  const grants = (value: unknown, path: string, allowed: readonly Role[] = ROLES): Grant[] =>
    arr(value, path).map((v, i) => {
      const g = obj(v, `${path}/${i}`);
      return {
        grantee: grantee(g["grantee"], `${path}/${i}/grantee`),
        role: roleIn(allowed, g["role"], `${path}/${i}/role`),
        addons: addons(g["addons"], `${path}/${i}/addons`),
      };
    });

  const orgs = new Map(
    entries(root["orgs"], "state/orgs").map(([key, o, path]) => {
      const orgPolicies = policies(o["policies"], `${path}/policies`);
      const members = new Map<string, OrgRole>(
        Object.entries(obj(o["members"], `${path}/members`)).map(([user, r]) => {
          if (!(ORG_ROLES as readonly unknown[]).includes(r)) throw new FixtureError(`${path}/members/${user}: unknown org role`);
          return [id(user, `${path}/members/${user}`), r as OrgRole];
        }),
      );
      return [key, { policies: orgPolicies, members }] as const;
    }),
  );
  const groups = new Map(
    entries(root["groups"], "state/groups").map(([key, g, path]) => [
      key,
      {
        org: id(g["org"], `${path}/org`),
        members: new Set(arr(g["members"], `${path}/members`).map((u, i) => id(u, `${path}/members/${i}`))),
      },
    ]),
  );
  const projects = new Map(
    entries(root["projects"], "state/projects").map(([key, p, path]) => [
      key,
      {
        org: id(p["org"], `${path}/org`),
        org_default_role: role(p["org_default_role"], `${path}/org_default_role`),
        grants: grants(p["grants"], `${path}/grants`),
        branch_rules: arr(p["branch_rules"], `${path}/branch_rules`).map((v, i, all): BranchRule => {
          const r = obj(v, `${path}/branch_rules/${i}`);
          const pattern = str(r["pattern"], `${path}/branch_rules/${i}/pattern`);
          if (all.slice(0, i).some((o) => obj(o, path)["pattern"] === pattern)) {
            throw new FixtureError(`${path}/branch_rules/${i}/pattern: duplicate pattern`);
          }
          return {
            pattern,
            merge_role: role(r["merge_role"], `${path}/branch_rules/${i}/merge_role`),
            push_role: role(r["push_role"], `${path}/branch_rules/${i}/push_role`),
          };
        }),
      },
    ]),
  );
  const files = new Map(
    entries(root["files"], "state/files").map(([key, f, path]) => [
      key,
      {
        project: id(f["project"], `${path}/project`),
        grants: grants(f["grants"], `${path}/grants`, FILE_GRANT_ROLES),
        restricted_to:
          f["restricted_to"] === null
            ? null
            : arr(f["restricted_to"], `${path}/restricted_to`).map((g, i) => grantee(g, `${path}/restricted_to/${i}`)),
      },
    ]),
  );
  const links = new Map(
    entries(root["links"], "state/links").map(([key, l, path]) => [
      key,
      {
        project: id(l["project"], `${path}/project`),
        file: optId(l["file"], `${path}/file`),
        role: roleIn(LINK_ROLES, l["role"], `${path}/role`),
        addons: addons(l["addons"], `${path}/addons`),
        expired: bool(l["expired"], `${path}/expired`),
        org_only: bool(l["org_only"], `${path}/org_only`),
      },
    ]),
  );

  const principal = (value: unknown, path: string): Principal => {
    const p = obj(value, path);
    switch (p["kind"]) {
      case "user":
        return { kind: "user", user: id(p["user"], `${path}/user`) };
      case "group":
        return { kind: "group", group: id(p["group"], `${path}/group`) };
      case "link":
        return { kind: "link", link: id(p["link"], `${path}/link`), user: optId(p["user"], `${path}/user`) };
      case "agent": {
        const s = obj(p["scope"], `${path}/scope`);
        const scope: AgentScope = {
          projects: arr(s["projects"], `${path}/scope/projects`).map((v, i) => id(v, `${path}/scope/projects/${i}`)),
          files: s["files"] === null ? null : arr(s["files"], `${path}/scope/files`).map((v, i) => id(v, `${path}/scope/files/${i}`)),
          capabilities: arr(s["capabilities"], `${path}/scope/capabilities`).map((c, i) => {
            const name = str(c, `${path}/scope/capabilities/${i}`);
            if (!isCapability(name)) throw new FixtureError(`${path}/scope/capabilities/${i}: unknown capability`);
            return name;
          }),
        };
        return {
          kind: "agent",
          session: id(p["session"], `${path}/session`),
          task: id(p["task"], `${path}/task`),
          on_behalf_of: id(p["on_behalf_of"], `${path}/on_behalf_of`),
          scope,
        };
      }
      default:
        throw new FixtureError(`${path}/kind: unknown principal kind`);
    }
  };
  const resource = (value: unknown, path: string): Resource => {
    const r = obj(value, path);
    switch (r["kind"]) {
      case "org":
        return { kind: "org", org: id(r["org"], `${path}/org`) };
      case "project":
        return { kind: "project", project: id(r["project"], `${path}/project`) };
      case "file":
        return { kind: "file", file: id(r["file"], `${path}/file`) };
      case "branch":
        return {
          kind: "branch",
          project: id(r["project"], `${path}/project`),
          file: optId(r["file"], `${path}/file`),
          branch: str(r["branch"], `${path}/branch`),
        };
      default:
        throw new FixtureError(`${path}/kind: unknown resource kind`);
    }
  };

  const cases = arr(casesJson, "cases").map((v, i): AuthzCase => {
    const c = obj(v, `cases/${i}`);
    const capability = str(c["capability"], `cases/${i}/capability`);
    if (!isCapability(capability)) throw new FixtureError(`cases/${i}/capability: unknown capability`);
    return {
      name: str(c["name"], `cases/${i}/name`),
      principal: principal(c["principal"], `cases/${i}/principal`),
      capability,
      resource: resource(c["resource"], `cases/${i}/resource`),
      expected: decision(c["expected"], `cases/${i}/expected`),
    };
  });

  return { ids, state: { orgs, groups, projects, files, links }, cases };
}

export const CANVAS_FIXTURES_DIR = fileURLToPath(new URL("../../fixtures/canvas-c6/", import.meta.url));

export interface CanvasCase extends AuthzCase {
  /** 0-based position after merging, vendored cases first. */
  index: number;
  pending?: string;
  decision?: string;
}

export interface CanvasFixtures {
  ids: ReadonlyMap<string, string>;
  state: AccessState;
  cases: CanvasCase[];
  /** Only the policy keys the JSON sets; schema defaults fill the rest. */
  explicitPolicies: ReadonlyMap<string, Partial<OrgPolicies>>;
  /** Fixture symbol for a UUID, for readable messages (the UUID itself when unknown). */
  symbolOf: (uuid: string) => string;
  /** The merged symbolic state JSON. */
  raw: Json;
}

const STATE_SECTIONS = ["ids", "orgs", "groups", "projects", "files", "links"] as const;

function mergeExtraState(stateJson: unknown, extraState: unknown): Json {
  const base = obj(stateJson, "state");
  const extra = obj(extraState, "extra/state");
  onlyKeys(extra, STATE_SECTIONS, "extra/state");
  const merged: Json = { ...base };
  for (const section of STATE_SECTIONS) {
    const add = section in extra ? obj(extra[section], `extra/state/${section}`) : {};
    const own = obj(base[section] ?? {}, `state/${section}`);
    for (const key of Object.keys(add)) {
      if (key in own) throw new FixtureError(`extra/state/${section}/${key}: already defined in state`);
    }
    merged[section] = { ...own, ...add };
  }
  return merged;
}

export function resolveCanvasFixtures(stateJson: unknown, casesJson: unknown, extraJson?: unknown): CanvasFixtures {
  let rawState = obj(stateJson, "state");
  let rawCases = arr(casesJson, "cases");
  const meta: { pending?: string; decision?: string }[] = rawCases.map(() => ({}));

  if (extraJson !== undefined) {
    const extra = obj(extraJson, "extra");
    onlyKeys(extra, ["pending", "note", "state", "cases"], "extra");
    rawState = mergeExtraState(rawState, field(extra, "state", "extra"));
    const extraCases = arr(field(extra, "cases", "extra"), "extra/cases");
    extraCases.forEach((v, i) => {
      const c = obj(v, `extra/cases/${i}`);
      meta.push({ pending: str(field(c, "pending", `extra/cases/${i}`), `extra/cases/${i}/pending`), decision: str(field(c, "decision", `extra/cases/${i}`), `extra/cases/${i}/decision`) });
    });
    // resolveAuthzFixtures ignores unknown case fields, so pending/decision ride along harmlessly.
    rawCases = [...rawCases, ...extraCases];
  }

  const base = resolveAuthzFixtures(rawState, rawCases);
  const explicitPolicies = new Map<string, Partial<OrgPolicies>>();
  for (const [symbol, org] of Object.entries(obj(rawState["orgs"], "state/orgs"))) {
    const given = obj(obj(org, `state/orgs/${symbol}`)["policies"], `state/orgs/${symbol}/policies`);
    explicitPolicies.set(base.ids.get(symbol)!, pickGiven(given, `state/orgs/${symbol}/policies`));
  }
  const symbols = new Map([...base.ids].map(([symbol, uuid]) => [uuid, symbol]));

  return {
    ids: base.ids,
    state: base.state,
    cases: base.cases.map((c, index) => ({ ...c, index, ...meta[index] })),
    explicitPolicies,
    symbolOf: (uuid) => symbols.get(uuid) ?? uuid,
    raw: rawState,
  };
}

function pickGiven(given: Json, path: string): Partial<OrgPolicies> {
  policies(given, path);
  return { ...given } as Partial<OrgPolicies>;
}

export function loadCanvasFixtures(opts: { extra?: boolean } = {}): CanvasFixtures {
  const read = (name: string): unknown => JSON.parse(readFileSync(join(CANVAS_FIXTURES_DIR, name), "utf8"));
  return resolveCanvasFixtures(read("state.json"), read("cases.json"), opts.extra === false ? undefined : read("extra-cases.json"));
}
