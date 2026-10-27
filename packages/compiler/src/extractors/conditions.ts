import type ts from 'typescript';
import type { Condition } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';

export function conditionOf(_node: ts.Node, _ctx: ExtractorContext): Condition | undefined {
  return undefined;
}
