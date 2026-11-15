/** Three-valued answer: Kleene logic, the same as ReBAC's `'member' | 'not' | 'unknown'` and a residual's TRUE / FALSE / UNKNOWN. */
export type Truth = 'allow' | 'deny' | 'unknown';

/** One step of a check, shaped for the Bet 5 `decision-tree` component. `source` locates the step in the IR or the data. */
export interface ExplainNode {
  label: string;
  truth: Truth;
  children: ExplainNode[];
  source: string;
}

export const explainNode = (label: string, truth: Truth, source: string, children: ExplainNode[] = []): ExplainNode => ({ label, truth, children, source });

export const and3 = (a: Truth, b: Truth): Truth => (a === 'deny' || b === 'deny' ? 'deny' : a === 'unknown' || b === 'unknown' ? 'unknown' : 'allow');

export const or3 = (a: Truth, b: Truth): Truth => (a === 'allow' || b === 'allow' ? 'allow' : a === 'unknown' || b === 'unknown' ? 'unknown' : 'deny');

export const not3 = (a: Truth): Truth => (a === 'allow' ? 'deny' : a === 'deny' ? 'allow' : 'unknown');
