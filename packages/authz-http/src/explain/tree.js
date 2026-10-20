import { definite, resourceKey } from '@spinajs/authz';
function verdict(d) {
    if (definite(d))
        return 'allow';
    if (d.allowed)
        return 'conditional';
    return `deny (${d.reason?.code ?? 'no_access'})`;
}
const why = (v) => (v.reason ? ` (${v.reason.code})` : '');
function voteVerdict(v) {
    if (v.error !== undefined)
        return `error (${v.error})`;
    if (v.denyWhen.op === 'true')
        return `deny${why(v)}`;
    if (v.permitWhen.op === 'true' && v.denyWhen.op === 'false')
        return 'permit';
    if (v.permitWhen.op === 'false' && v.denyWhen.op === 'false')
        return `abstain${why(v)}`;
    return 'conditional';
}
// Steps carry no verdict of their own; they take their parent's.
const stepNodes = (steps, allowed) => steps.map((s) => ({ label: `${s.by} ${s.step}: ${s.note}`, allowed, children: [] }));
export function explainTree(d) {
    const allowed = definite(d);
    const children = [];
    if (d.trace) {
        for (const v of d.trace.votes) {
            const label = voteVerdict(v);
            children.push({ label: `${v.model}: ${label}`, allowed: label === 'permit', children: stepNodes(v.trace ?? [], label === 'permit') });
        }
        children.push({ label: `${d.trace.algorithm} over [${d.trace.models.join(', ')}] in ${d.trace.domain}`, allowed, children: stepNodes(d.trace.steps, allowed) });
    }
    return { label: `${resourceKey(d.resource)}#${d.permission} = ${verdict(d)}`, allowed, children };
}
//# sourceMappingURL=tree.js.map