import type { Decision } from '@spinajs/authz';
/** A generic explanation tree; the shape of ckit's `ExplainNode` (design §10.6). */
export interface ExplainNode {
    readonly label: string;
    readonly allowed: boolean;
    readonly children: readonly ExplainNode[];
}
export declare function explainTree(d: Decision): ExplainNode;
//# sourceMappingURL=tree.d.ts.map