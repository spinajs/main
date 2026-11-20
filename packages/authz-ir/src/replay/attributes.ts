import { resourceKey } from '@spinajs/authz';
import type { CapturedInputs, ChangeRecord, ReplayDivergence, ReplayRead, ResourceRef } from '@spinajs/authz';

import type { AttributeHistoryContributor, AttributeLeafImage } from './contributor.js';
import { coverageGap, sameImage, stateAt } from './history.js';
import type { KeyState } from './history.js';
import type { ReplayHistory } from './history-scan.js';

const KIND = 'attribute';
// Leaves are scalars read from a text column, never instants of a date column: compared exactly whatever the
// changelog's precision.
const LEAF_PRECISION_MS = 1;

interface CapturedNode {
  ref: ResourceRef;
  value: Readonly<Record<string, unknown>>;
}

interface CapturedStateCheck {
  divergence: ReplayDivergence[];
  /** Every leaf key resolved, and where its state came from. */
  reads: ReplayRead[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const gapRead = (key: string, reason: string): ReplayRead => ({ kind: KIND, key, origin: 'gap', reason });

/** The scope nodes the decision loaded, as captured. A node the engine could not load was captured as null. */
export function capturedNodes(inputs: CapturedInputs): CapturedNode[] {
  const nodes = new Map<string, CapturedNode>();
  for (const a of inputs.attributes) {
    const ref = a.ref;
    if (a.path !== '' || !isRecord(ref) || typeof ref.type !== 'string' || (ref.id != null && typeof ref.id !== 'string') || !isRecord(a.value)) continue;
    const node = { ref: ref.id == null ? { type: ref.type } : { type: ref.type, id: ref.id }, value: a.value };
    nodes.set(resourceKey(node.ref), node);
  }
  return [...nodes.values()];
}

/**
 * Rule 6 of section 3.6: every leaf the attribute store held at T for a captured node must show in the capture with
 * that value, since the store is the last layer the engine merges. A leaf the store did not hold proves nothing (schema
 * defaults and adapters fill the node too), and a gap gives no finding.
 */
export async function checkCapturedState(at: Date, inputs: CapturedInputs, c: AttributeHistoryContributor, history: ReplayHistory): Promise<CapturedStateCheck> {
  const out: CapturedStateCheck = { divergence: [], reads: [] };
  const nodes = capturedNodes(inputs);
  // Read before the store as well: an app whose attributes never reached the changelog may not have its table.
  const uncovered = coverageGap(at, KIND, await history.since(KIND), history.window);
  if (uncovered !== undefined) return { divergence: [], reads: nodes.map((n) => gapRead(resourceKey(n.ref), uncovered)) };
  for (const node of nodes) await checkNode(at, node, c, history, out);
  return out;
}

/** Current leaves, then the scan's tail, heads, changes before T and the coverage, in the order of section 3.2. */
async function checkNode(at: Date, node: CapturedNode, c: AttributeHistoryContributor, history: ReplayHistory, out: CapturedStateCheck): Promise<void> {
  const scope = resourceKey(node.ref);
  for (let attempt = 0; ; attempt++) {
    const now = new Map((await c.current(node.ref)).map((leaf): [string, AttributeLeafImage] => [leaf.path, leaf]));
    await history.catchUp();
    const keys = new Map([...candidatePaths(scope, now, history, out)].sort().map((p): [string, string] => [c.key(node.ref, p), p]));
    const heads = await history.headOf(KIND, [...keys.keys()]);
    const befores = await history.beforeOf(KIND, [...keys.keys()]);
    const since = await history.since(KIND);
    const uncovered = coverageGap(at, KIND, since, history.window);
    if (uncovered !== undefined) {
      out.reads.push(gapRead(scope, uncovered));
      return;
    }
    const moved = new Set(
      [...keys.keys()].filter((k) => {
        const head = heads.get(k);
        return head !== undefined && head.seq > Math.max(history.afterFor(KIND, k).at(-1)?.seq ?? -Infinity, befores.get(k)?.seq ?? -Infinity);
      }),
    );
    if (moved.size > 0 && attempt === 0) continue;
    for (const [key, path] of keys) {
      const state: KeyState = moved.has(key)
        ? { known: false, reason: `${KIND} ${key} changed during the replay` }
        : stateAt(at, { kind: KIND, current: now.get(path), after: history.afterFor(KIND, key), before: befores.get(key), since, window: history.window, precisionMs: LEAF_PRECISION_MS });
      compare(state, key, `${scope}#${path}`, leafIn(node.value, path), out);
    }
    return;
  }
}

/** The node's leaves now and those its scanned changes name. A change that names no leaf may hide one: a gap. */
function candidatePaths(scope: string, now: ReadonlyMap<string, AttributeLeafImage>, history: ReplayHistory, out: CapturedStateCheck): Set<string> {
  const paths = new Set(now.keys());
  for (const change of history.changesOf(KIND)) {
    const leaf = leafOf(change);
    if (leaf === undefined) out.reads.push(gapRead(change.key, `change seq ${change.seq} names no scope attribute leaf`));
    else if (leaf.scope === scope) paths.add(leaf.path);
  }
  return paths;
}

function leafOf(change: ChangeRecord): { scope: string; path: string } | undefined {
  const image = isRecord(change.payload) ? change.payload : change.before;
  return isRecord(image) && typeof image.scope === 'string' && typeof image.path === 'string' ? { scope: image.scope, path: image.path } : undefined;
}

function leafIn(captured: Readonly<Record<string, unknown>>, path: string): unknown {
  let seen: unknown = captured;
  for (const segment of path.split('.')) seen = isRecord(seen) && own(seen, segment) ? seen[segment] : undefined;
  return seen;
}

/** A known leaf at T that the capture shows otherwise is a finding; an image without a readable value is a gap. */
function compare(state: KeyState, key: string, name: string, captured: unknown, out: CapturedStateCheck): void {
  if (!state.known) {
    out.reads.push(gapRead(key, state.reason));
    return;
  }
  const image = state.value;
  if (image !== undefined && !(isRecord(image) && own(image, 'value'))) {
    out.reads.push(gapRead(key, `the ${state.origin === 'current' ? 'stored' : 'logged'} leaf holds no readable value`));
    return;
  }
  out.reads.push({ kind: KIND, key, origin: state.origin, ...(state.seq === undefined ? {} : { seq: state.seq }) });
  if (image === undefined || sameImage(image.value, captured, LEAF_PRECISION_MS)) return;
  out.divergence.push({ part: 'captured-state', key: name, recorded: captured === undefined ? 'absent' : JSON.stringify(captured), replayed: JSON.stringify(image.value) });
}
