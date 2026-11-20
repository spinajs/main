import type { CoerceIn } from './coerce.js';
import { ajvFinite } from './keywords.js';

/**
 * What Ajv (`coerceTypes: 'array'`) does to the data of a schema, as the generated code describes it: the in-place
 * coercion of each keyword that is run, in the order Ajv runs them. The server then refuses a non-finite number left
 * anywhere in the data, whether or not the keyword that coerced it held.
 *
 * Inside a `not` and the `if` of a conditional Ajv stops at the first keyword that fails (it does not collect errors
 * there), so the plan carries the validity of what comes before each keyword (`pre`) and of each member (`ok`).
 */
export interface ReplayPlan {
  /** The coercion at the node's own `type`. */
  coerce?: CoerceIn;
  /** The schemas `$merge` and `$patch` resolve to, run on the same data before anything else. */
  merged?: readonly ReplayPlan[];
  /** The `$ref` target; not `inline` when Ajv compiles it as a function of its own. */
  ref?: ReplayPlan | ReplayBack;
  inline?: boolean;
  not?: ReplayPlan;
  /** Each member has `ok`: `anyOf` stops at the first that accepts what it was left with. */
  anyOf?: readonly ReplayPlan[];
  oneOf?: readonly ReplayPlan[];
  allOf?: readonly ReplayPlan[];
  cond?: { test: ReplayPlan; then?: ReplayPlan; else?: ReplayPlan };
  items?: ReplayPlan | readonly ReplayPlan[];
  rest?: ReplayPlan;
  contains?: ReplayPlan;
  props?: readonly (readonly [string, ReplayPlan])[];
  patterns?: readonly (readonly [RegExp, ReplayPlan])[];
  /** `additionalProperties`: the keys that neither `declared` nor a pattern of `patterns` covers. */
  extra?: ReplayPlan;
  declared?: readonly string[];
  deps?: readonly (readonly [string, ReplayPlan])[];
  /** Whether the schema of this node accepts the value. */
  ok?: (value: unknown) => boolean;
  /** Whether the keywords that Ajv runs before the stage accept the value. */
  pre?: Partial<Record<ReplayStage, (value: unknown) => boolean>>;
}

export type ReplayStage = 'merged' | 'ref' | 'not' | 'anyOf' | 'oneOf' | 'allOf' | 'if' | 'rest' | 'items' | 'contains' | 'extra' | 'deps' | 'props' | 'patterns';

/** The plan of the n-th enclosing `$ref` target: a recursive schema reads itself. */
export interface ReplayBack {
  back: number;
}

interface State {
  /** The variable Ajv's compiled code reads the node's data from. */
  local: unknown;
  /** The slot of the parent that holds it, which is what the final data keeps. */
  slot: unknown;
}

type Frames = readonly ReplayPlan[];
type Open = (stage: ReplayStage) => boolean;

const isContainer = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The plan to run and the `$ref` targets around it: a back reference returns to the frames of its target. */
function resolve(plan: ReplayPlan | ReplayBack, frames: Frames): [ReplayPlan, Frames] | undefined {
  if (!('back' in plan)) return [plan, frames];
  const at = frames.length - 1 - plan.back;
  return frames[at] ? [frames[at], frames.slice(0, at + 1)] : undefined;
}

/** A copy to change in place, as Ajv changes its data: an own `__proto__` key is kept as the key it is. */
function copy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copy);
  if (!isContainer(value)) return value;
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(value)) Object.defineProperty(clone, key, { value: copy(value[key]), enumerable: true, writable: true, configurable: true });
  return clone;
}

function put(container: object, key: string, value: unknown): void {
  Object.defineProperty(container, key, { value, enumerable: true, writable: true, configurable: true });
}

/** The data of one node while its keywords run: Ajv's variable, the slot of the parent, and where the node sits. */
interface Walk {
  plan: ReplayPlan;
  local: unknown;
  slot: unknown;
  hasSlot: boolean;
  frames: Frames;
  short: boolean;
  /** The value the node was given: the keywords before a stage were judged on it. */
  given: unknown;
}

function follow(walk: Walk, member: ReplayPlan | ReplayBack, options: { compiled?: boolean; ref?: boolean; short?: boolean } = {}): void {
  const found = resolve(member, walk.frames);
  if (!found) return;
  const frames = options.ref && !('back' in member) ? [...found[1], found[0]] : found[1];
  const next = run(found[0], { local: walk.local, slot: walk.slot }, walk.hasSlot, frames, options.short ?? walk.short);
  // A compiled target writes the parent's slot, and the variable of the caller stays as it was.
  if (!options.compiled) walk.local = next.local;
  walk.slot = next.slot;
}

const stageOpen = (walk: Walk, stage: ReplayStage): boolean => !walk.short || walk.plan.pre?.[stage]?.(walk.given) !== false;

/** The members of a list in turn; `stops` says, from the value a member was offered, whether the list ends there. */
function inTurn(walk: Walk, members: readonly ReplayPlan[], stops: (member: ReplayPlan, offered: unknown) => boolean): void {
  for (const member of members) {
    // Whether a member held is decided on the value it was given: a container is changed in place, so it is kept as it was.
    const offered = copy(walk.local);
    follow(walk, member);
    if (stops(member, offered)) break;
  }
}

function references(walk: Walk): void {
  const { plan } = walk;
  if (plan.merged && stageOpen(walk, 'merged')) for (const member of plan.merged) follow(walk, member);
  if (plan.ref && stageOpen(walk, 'ref')) follow(walk, plan.ref, { compiled: plan.inline === false, ref: true });
}

function applicators(walk: Walk): void {
  const { plan } = walk;
  references(walk);
  if (plan.not && stageOpen(walk, 'not')) follow(walk, plan.not, { short: true });
  if (plan.anyOf && stageOpen(walk, 'anyOf')) inTurn(walk, plan.anyOf, (member, offered) => member.ok?.(offered) === true);
  if (plan.oneOf && stageOpen(walk, 'oneOf')) inTurn(walk, plan.oneOf, () => false);
  if (plan.allOf && stageOpen(walk, 'allOf')) inTurn(walk, plan.allOf, (member, offered) => walk.short && member.ok !== undefined && !member.ok(offered));
  if (plan.cond && stageOpen(walk, 'if')) conditional(walk, plan.cond);
}

function conditional(walk: Walk, cond: NonNullable<ReplayPlan['cond']>): void {
  const offered = copy(walk.local);
  follow(walk, cond.test, { short: true });
  const branch = cond.test.ok?.(offered) ? cond.then : cond.else;
  if (branch) follow(walk, branch);
}

function run(plan: ReplayPlan, state: State, hasSlot: boolean, frames: Frames, short: boolean): State {
  const walk: Walk = { plan, local: state.local, slot: state.slot, hasSlot, frames, short, given: plan.pre ? copy(state.local) : state.local };
  if (plan.coerce) {
    const coerced = plan.coerce(walk.local);
    walk.local = coerced.local;
    if (hasSlot && coerced.set) walk.slot = coerced.local;
    // Where Ajv stops at the first failure, the finite check of a numeric `type` on an infinity ends the node.
    if (short && plan.coerce.numeric && typeof walk.local === 'number' && !Number.isFinite(walk.local)) return { local: walk.local, slot: walk.slot };
  }
  applicators(walk);
  if (isContainer(walk.local)) {
    const open: Open = (stage) => !short || plan.pre?.[stage]?.(walk.given) !== false;
    if (Array.isArray(walk.local)) array(plan, walk.local, frames, short, open);
    else object(plan, walk.local, frames, short, open);
  }
  return { local: walk.local, slot: walk.slot };
}

/** A child is a data location with a parent to assign into; true when it stopped the keyword by being invalid. */
function visit(child: ReplayPlan, container: object, key: string, frames: Frames, short: boolean): boolean {
  const value: unknown = Reflect.get(container, key);
  const given = short && child.ok ? copy(value) : value;
  const result = run(child, { local: value, slot: value }, true, frames, short);
  put(container, key, result.slot);
  return short && child.ok !== undefined && !child.ok(given);
}

function isTuple(items: ReplayPlan['items']): items is readonly ReplayPlan[] {
  return Array.isArray(items);
}

function array(plan: ReplayPlan, list: unknown[], frames: Frames, short: boolean, open: Open): void {
  const each = (stage: ReplayStage, from: number, to: number, planOf: (index: number) => ReplayPlan | undefined): void => {
    if (!open(stage)) return;
    for (let i = from; i < to; i++) {
      const child = planOf(i);
      if (child && visit(child, list, String(i), frames, short)) return;
    }
  };
  const items = plan.items;
  if (isTuple(items)) {
    each('rest', items.length, list.length, () => plan.rest);
    each('items', 0, Math.min(items.length, list.length), (i) => items[i]);
  } else if (items) {
    each('items', 0, list.length, () => items);
  }
  if (plan.contains && open('contains')) {
    for (let i = 0; i < list.length; i++) {
      const given = copy(list[i]);
      visit(plan.contains, list, String(i), frames, short);
      if (plan.contains.ok?.(given)) break;
    }
  }
}

function object(plan: ReplayPlan, current: Record<string, unknown>, frames: Frames, short: boolean, open: Open): void {
  const each = (stage: ReplayStage, entries: readonly (readonly [string, ReplayPlan])[]): void => {
    if (!open(stage)) return;
    for (const [key, child] of entries) {
      if (!Object.hasOwn(current, key) || current[key] === undefined) continue;
      if (visit(child, current, key, frames, short)) return;
    }
  };
  const covered = (key: string): boolean => (plan.declared ?? []).includes(key) || (plan.patterns ?? []).some(([pattern]) => pattern.test(key));
  const extra = plan.extra;
  if (extra) each('extra', Object.keys(current).filter((key) => !covered(key)).map((key): [string, ReplayPlan] => [key, extra]));
  if (plan.deps && open('deps')) {
    for (const [key, dependency] of plan.deps) {
      if (!Object.hasOwn(current, key)) continue;
      const given = copy(current);
      run(dependency, { local: current, slot: current }, true, frames, short);
      if (short && dependency.ok && !dependency.ok(given)) break;
    }
  }
  if (plan.props) each('props', plan.props);
  if (plan.patterns && open('patterns')) {
    for (const [pattern, child] of plan.patterns) {
      for (const key of Object.keys(current).filter((k) => pattern.test(k))) {
        if (visit(child, current, key, frames, short)) return;
      }
    }
  }
}

/**
 * Whether the data Ajv validated holds no non-finite number once it has run the coercions of `plan` on `value`. A root
 * (`rooted`) has no parent to assign into, so only what it holds is changed.
 */
export function finiteAfter(plan: ReplayPlan, value: unknown, rooted: boolean): boolean {
  const data = copy(value);
  return ajvFinite(run(plan, { local: data, slot: data }, !rooted, [], false).slot);
}

/** `finiteAfter` for a plan fixed in advance: the check the generated code holds. */
export function finiteReplay(plan: ReplayPlan, rooted: boolean): (value: unknown) => boolean {
  return (value) => finiteAfter(plan, value, rooted);
}

/**
 * The value Ajv's variable holds after `plan` has run on `value`: what the next branch of a union is given. It is
 * fixed in advance like `finiteReplay`. `short` when the node sits in a `not` or the test of an `if`.
 */
export function replayLocal(plan: ReplayPlan, short = false): (value: unknown) => unknown {
  return (value) => {
    const data = copy(value);
    return run(plan, { local: data, slot: data }, true, [], short).local;
  };
}
