import { resourceKey } from '@spinajs/authz';
import type { Decision, TraceStep, Vote } from '@spinajs/authz';

/** A generic explanation tree; the shape of ckit's `ExplainNode` (design §10.6). */
export interface ExplainNode {
  readonly label: string;
  readonly allowed: boolean;
  readonly children: readonly ExplainNode[];
}

const definite = (d: Decision): boolean => d.allowed && d.residual.op === 'true';

function verdict(d: Decision): string {
  if (definite(d)) return 'allow';
  if (d.allowed) return 'conditional';
  return `deny (${d.reason?.code ?? 'no_access'})`;
}

const why = (v: Vote): string => (v.reason ? ` (${v.reason.code})` : '');

function voteVerdict(v: Vote): string {
  if (v.error !== undefined) return `error (${v.error})`;
  if (v.denyWhen.op === 'true') return `deny${why(v)}`;
  if (v.permitWhen.op === 'true' && v.denyWhen.op === 'false') return 'permit';
  if (v.permitWhen.op === 'false' && v.denyWhen.op === 'false') return `abstain${why(v)}`;
  return 'conditional';
}

// Steps carry no verdict of their own; they take their parent's.
const stepNodes = (steps: readonly TraceStep[], allowed: boolean): ExplainNode[] => steps.map((s) => ({ label: `${s.by} ${s.step}: ${s.note}`, allowed, children: [] }));

export function explainTree(d: Decision): ExplainNode {
  const allowed = definite(d);
  const children: ExplainNode[] = [];
  if (d.trace) {
    for (const v of d.trace.votes) {
      const label = voteVerdict(v);
      children.push({ label: `${v.model}: ${label}`, allowed: label === 'permit', children: stepNodes(v.trace ?? [], label === 'permit') });
    }
    children.push({ label: `${d.trace.algorithm} over [${d.trace.models.join(', ')}] in ${d.trace.domain}`, allowed, children: stepNodes(d.trace.steps, allowed) });
  }
  return { label: `${resourceKey(d.resource)}#${d.permission} = ${verdict(d)}`, allowed, children };
}
