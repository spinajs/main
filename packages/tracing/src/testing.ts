import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

import { ensureTracing, resetTracingState, tracingState } from './bootstrap.js';
import { DEFAULT_TRACING_OPTIONS } from './options.js';

export interface SpanTreeNode {
  readonly span: ReadableSpan;
  readonly children: SpanTreeNode[];
}

export interface InMemorySpans {
  spans(): ReadableSpan[];
  byName(name: string): ReadableSpan[];
  tree(): SpanTreeNode[];
  waitFor(name: string, timeoutMs?: number): Promise<ReadableSpan>;
  reset(): void;
  detach(): Promise<void>;
}

export const resetTracing = resetTracingState;

/** The W3C trace-flags a request answers while nothing records (program open decision 1: keep E4). Tests read it from here. */
export const ID_ONLY_TRACE_FLAGS: '00' | '01' = '00';

// Collects synchronously in onEnd: SimpleSpanProcessor exports through a promise, which a test would have to await.
class CollectingProcessor implements SpanProcessor {
  public readonly finished: ReadableSpan[] = [];

  public onStart(): void {}

  public onEnd(span: ReadableSpan): void {
    this.finished.push(span);
  }

  public forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  public shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const startedBefore = (a: SpanTreeNode, b: SpanTreeNode): number => a.span.startTime[0] - b.span.startTime[0] || a.span.startTime[1] - b.span.startTime[1];

function treeOf(spans: readonly ReadableSpan[]): SpanTreeNode[] {
  const nodes = new Map<string, SpanTreeNode>(spans.map((span) => [span.spanContext().spanId, { span, children: [] }]));
  const roots: SpanTreeNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.span.parentSpanContext?.spanId;
    const parent = parentId === undefined ? undefined : nodes.get(parentId);
    (parent ? parent.children : roots).push(node);
  }
  for (const node of nodes.values()) node.children.sort(startedBefore);
  return roots.sort(startedBefore);
}

async function waitForSpan(finished: readonly ReadableSpan[], name: string, timeoutMs: number): Promise<ReadableSpan> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = finished.find((s) => s.name === name);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`useInMemorySpans: no span named "${name}" ended within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function useInMemorySpans(): InMemorySpans {
  const state = tracingState().owner === 'none' ? ensureTracing({ ...DEFAULT_TRACING_OPTIONS, serviceName: 'spinajs-test' }) : tracingState();
  if (!state.hub) {
    throw new Error(`useInMemorySpans: tracing is owned by '${state.owner}'; add a processor to that SDK instead`);
  }

  const collector = new CollectingProcessor();
  const detach = state.hub.add(collector);
  return {
    spans: () => [...collector.finished],
    byName: (name) => collector.finished.filter((s) => s.name === name),
    tree: () => treeOf(collector.finished),
    waitFor: (name, timeoutMs = 2000) => waitForSpan(collector.finished, name, timeoutMs),
    reset: () => {
      collector.finished.length = 0;
    },
    detach,
  };
}
