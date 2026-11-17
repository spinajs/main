import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

/** A durable call, as the code that runs after it sees it. */
export interface LineageNode {
  readonly owner: Lineage;
  /** The branch the call was counted in; '' is the activation's root branch. */
  readonly branch: string;
  readonly key: string;
  /** The node the call was placed under. */
  readonly parent: LineageNode | undefined;
  /** The synchronous turn the call was made in; -1 for a node no call made. */
  readonly turn: number;
  /** Another call was made next to this one in the same synchronous turn: what follows it is a branch of its own. */
  forked: boolean;
}

const current = new AsyncLocalStorage<LineageNode>();

function next(counts: Map<string, number>, id: string): number {
  const n = (counts.get(id) ?? 0) + 1;
  counts.set(id, n);
  return n;
}

/** The branch that continues after `forkKey`, a forked call of `parentBranch`. */
export function branchId(parentBranch: string, forkKey: string): string {
  return createHash('sha256').update(`${parentBranch}\n${forkKey}`).digest('hex').slice(0, 12);
}

export function branchOfKey(key: string): string {
  const at = key.lastIndexOf('@');
  return at > key.lastIndexOf('#') ? key.slice(at + 1) : '';
}

/**
 * @internal
 * Occurrences and calls counted per branch (Amendment 41). An awaited call becomes the store the code after its await
 * resumes in. A store made in the current synchronous turn was not awaited by the caller: it leaked from the call made
 * just before, so the two are siblings, they stay in their caller's branch, and what follows each is a branch of its
 * own. Which call settles first plays no part.
 */
export class Lineage {
  public readonly root: LineageNode = { owner: this, branch: '', key: '', parent: undefined, turn: -1, forked: false };
  protected readonly calls = new Map<string, number>();
  protected readonly occurrences = new Map<string, number>();
  protected turn = 0;
  protected turnEnding = false;

  public run<T>(fn: () => T): T {
    return current.run(this.root, fn);
  }

  /** `base` is `kind:name`; `call` numbers the calls of the branch from 1. An awaited call also becomes the store of the code after it. */
  public take(base: string, awaited: boolean): { key: string; call: number } {
    const { parent, branch, turn, sibling } = this.place();
    const call = next(this.calls, branch);
    const occurrence = next(this.occurrences, `${branch}|${base}`);
    const key = branch === '' ? `${base}#${occurrence}` : `${base}#${occurrence}@${branch}`;
    if (awaited) current.enterWith({ owner: this, branch, key, parent, turn, forked: sibling });
    return { key, call };
  }

  /** Where a call made now belongs. */
  protected place(): { parent: LineageNode; branch: string; turn: number; sibling: boolean } {
    const turn = this.currentTurn();
    const store = current.getStore();
    // code that was not entered through run() (a unit test) can still hold a node of an earlier activation
    const held = store?.owner === this ? store : this.root;
    const sibling = held.turn === turn;
    if (sibling) held.forked = true;
    const parent = sibling ? (held.parent ?? this.root) : held;
    return { parent, branch: parent.forked ? branchId(parent.branch, parent.key) : parent.branch, turn, sibling };
  }

  /** A turn ends at the next microtask. A promise job, not queueMicrotask, which a fake-timer library can replace. */
  protected currentTurn(): number {
    if (!this.turnEnding) {
      this.turnEnding = true;
      void Promise.resolve().then(() => this.endTurn());
    }
    return this.turn;
  }

  protected endTurn(): void {
    this.turnEnding = false;
    this.turn++;
  }
}
