import 'mocha';
import { expect } from 'chai';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode } from '@opentelemetry/api';

import { RingBuffer } from '../src/buffers/ring.js';
import { TraceStore } from '../src/buffers/trace-store.js';
import type { TraceSummary } from '../src/contracts/index.js';
import { StudioSpanProcessor } from '../src/processor.js';
import { MAX_ATTRIBUTE_BYTES } from '../src/span.js';
import { fakeSpan, traceIdOf } from './support/spans.js';
import type { FakeSpan } from './support/spans.js';

const NO_PARENT = ROOT_CONTEXT;

function store(o: { traces?: number; spansPerTrace?: number; maxBytes?: number; redact?: string[]; captureBindings?: boolean } = {}) {
  const s = new TraceStore({ traces: o.traces ?? 10, spansPerTrace: o.spansPerTrace ?? 100, maxBytes: o.maxBytes ?? 1_000_000, capture: { redact: new Set(o.redact ?? []), captureBindings: o.captureBindings ?? false }, basePath: '/api/_studio' });
  return { store: s, processor: new StudioSpanProcessor(() => s) };
}

function run(processor: StudioSpanProcessor, span: FakeSpan) {
  const s = fakeSpan(span);
  processor.onStart(s, NO_PARENT);
  processor.onEnd(s);
  return s;
}

describe('RingBuffer', () => {
  it('keeps the newest entries, oldest first', () => {
    const ring = new RingBuffer<number>(3);
    for (const n of [1, 2, 3, 4, 5]) ring.push(n);
    expect(ring.toArray()).to.deep.eq([3, 4, 5]);
    expect(ring.size).to.eq(3);
  });

  it('refuses a capacity below one', () => {
    expect(() => new RingBuffer<number>(0)).to.throw(RangeError);
  });
});

describe('TraceStore', () => {
  it('evicts the first buffered trace once the cap is hit', () => {
    const { store: s, processor } = store({ traces: 2 });
    run(processor, { trace: 'a', id: '1', startMs: 100 });
    run(processor, { trace: 'b', id: '2', startMs: 50 });
    run(processor, { trace: 'c', id: '3', startMs: 200 });
    expect(s.list({}).items.map((t) => t.traceId)).to.deep.eq([traceIdOf('c'), traceIdOf('b')]);
  });

  it('evicts the first buffered traces past the byte budget and keeps the one being written', () => {
    const { store: s, processor } = store({ maxBytes: 3000 });
    run(processor, { trace: 'a', id: '1', attributes: { note: 'x'.repeat(1000) } });
    run(processor, { trace: 'b', id: '2', attributes: { note: 'x'.repeat(1000) } });
    expect(s.list({}).items.map((t) => t.traceId)).to.deep.eq([traceIdOf('b')]);
    run(processor, { trace: 'c', id: '3', attributes: { note: 'x'.repeat(5000) } });
    expect(s.list({}).items.map((t) => t.traceId)).to.deep.eq([traceIdOf('c')]);
  });

  it('marks a trace that comes back after its eviction as truncated', () => {
    const { store: s, processor } = store({ traces: 1 });
    run(processor, { trace: 'a', id: '2', parent: '1' });
    run(processor, { trace: 'b', id: '3' });
    run(processor, { trace: 'a', id: '1' });
    expect(s.get(traceIdOf('a'))).to.include({ truncated: true });
  });

  it('marks a trace truncated past spansPerTrace', () => {
    const { store: s, processor } = store({ spansPerTrace: 2 });
    for (const id of ['2', '3', '4']) run(processor, { trace: 't', id, parent: '1' });
    const detail = s.get(traceIdOf('t'));
    expect(detail?.spans).to.have.length(2);
    expect(detail?.truncated).to.eq(true);
  });

  it('redacts configured attributes, cuts values past 2 KiB and drops bindings', () => {
    const { store: s, processor } = store({ redact: ['http.request.header.authorization'] });
    run(processor, { trace: 'r', id: '1', attributes: { 'http.request.header.authorization': 'Bearer x', 'db.query.text': 'x'.repeat(3000), 'db.query.parameter.0': 'secret' } });
    const [span] = s.get(traceIdOf('r'))?.spans ?? [];
    expect(span.attributes['http.request.header.authorization']).to.eq('[redacted]');
    const text = span.attributes['db.query.text'];
    expect(typeof text).to.eq('string');
    expect(Buffer.byteLength(String(text))).to.be.at.most(MAX_ATTRIBUTE_BYTES + Buffer.byteLength('…'));
    expect(span.attributes).to.not.have.property('db.query.parameter.0');
  });

  it('keeps bindings when captureBindings is on', () => {
    const { store: s, processor } = store({ captureBindings: true });
    run(processor, { trace: 'b', id: '1', attributes: { 'db.query.parameter.0': 'value' } });
    expect(s.get(traceIdOf('b'))?.spans[0].attributes['db.query.parameter.0']).to.eq('value');
  });

  it('lists a trace whose root has not ended as incomplete, named after the open root', () => {
    const { store: s, processor } = store();
    processor.onStart(fakeSpan({ trace: 'o', id: '1', name: 'GET /orders', kind: SpanKind.SERVER }), NO_PARENT);
    run(processor, { trace: 'o', id: '2', parent: '1', name: 'db.query' });
    expect(s.list({}).items[0]).to.include({ rootName: 'GET /orders', rootKind: 'server', complete: false, spanCount: 1 });
  });

  it('cuts the name of an open root at 2 KiB', () => {
    const { store: s, processor } = store();
    processor.onStart(fakeSpan({ trace: 'l', id: '1', name: 'x'.repeat(3000) }), NO_PARENT);
    expect(Buffer.byteLength(s.list({}).items[0].rootName)).to.be.at.most(MAX_ATTRIBUTE_BYTES + Buffer.byteLength('…'));
  });

  it('charges a root that arrives past spansPerTrace to the byte budget', () => {
    const { store: s, processor } = store({ spansPerTrace: 1, maxBytes: 1500 });
    run(processor, { trace: 'a', id: '2', parent: '1' });
    run(processor, { trace: 'a', id: '1', attributes: { note: 'x'.repeat(1000) } });
    run(processor, { trace: 'b', id: '3' });
    expect(s.list({}).items.map((t) => t.traceId)).to.deep.eq([traceIdOf('b')]);
  });

  it('treats a span with a remote parent as the local root', () => {
    const { store: s, processor } = store();
    run(processor, { trace: 'x', id: '1', parent: '9', remoteParent: true, name: 'GET /remote', kind: SpanKind.SERVER });
    expect(s.list({}).items[0]).to.include({ complete: true, rootName: 'GET /remote' });
  });

  it('notifies subscribers once per finished root and keeps the summary facts', () => {
    const { store: s, processor } = store();
    const seen: TraceSummary[] = [];
    const off = s.subscribe((summary) => seen.push(summary));
    run(processor, { trace: 'n', id: '2', parent: '1', status: SpanStatusCode.ERROR });
    expect(seen).to.have.length(0);
    run(processor, { trace: 'n', id: '1', attributes: { 'http.route': '/x', 'http.response.status_code': 201, 'spina.principal.id': 'user:bob' } });
    expect(seen).to.have.length(1);
    expect(seen[0]).to.include({ traceId: traceIdOf('n'), route: '/x', statusCode: 201, principalId: 'user:bob', spanCount: 2, errorCount: 1, complete: true });
    off();
    run(processor, { trace: 'm', id: '1' });
    expect(seen).to.have.length(1);
  });

  it("drops Studio's own request: its local root under the prefixed mount and every span started below it", () => {
    const { store: s, processor } = store();
    const root = fakeSpan({ trace: 's', id: '1', kind: SpanKind.SERVER, attributes: { 'url.path': '/api/_studio/api/traces' } });
    processor.onStart(root, NO_PARENT);
    run(processor, { trace: 's', id: '2', parent: '1' });
    processor.onEnd(root);
    const upper = fakeSpan({ trace: 'u', id: '3', kind: SpanKind.SERVER, attributes: { 'url.path': '/API/_STUDIO/api/traces' } });
    processor.onStart(upper, NO_PARENT);
    run(processor, { trace: 'u', id: '4', parent: '3' });
    processor.onEnd(upper);
    expect(s.size).to.eq(0);
    expect(s.get(traceIdOf('s'))).to.eq(undefined);
  });

  it('keeps a trace when a Studio request arrives with the same, caller-chosen trace id', () => {
    const { store: s, processor } = store();
    run(processor, { trace: 'x', id: '1', kind: SpanKind.SERVER, name: 'GET /orders', attributes: { 'url.path': '/api/orders' } });
    run(processor, { trace: 'x', id: '2', parent: '9', remoteParent: true, kind: SpanKind.SERVER, attributes: { 'url.path': '/api/_studio/api/capabilities' } });

    const open = fakeSpan({ trace: 'y', id: '3', parent: '9', remoteParent: true, kind: SpanKind.SERVER, attributes: { 'url.path': '/api/_studio/x' } });
    processor.onStart(open, NO_PARENT);
    run(processor, { trace: 'y', id: '4', kind: SpanKind.SERVER, name: 'GET /pay', attributes: { 'url.path': '/api/pay' } });
    processor.onEnd(open);

    expect(s.get(traceIdOf('x'))?.spans.map((span) => span.name)).to.deep.eq(['GET /orders']);
    expect(s.list({}).items.map((t) => t.rootName).sort()).to.deep.eq(['GET /orders', 'GET /pay']);
  });

  it('filters by route, status and duration, newest first, with an opaque cursor', () => {
    const { store: s, processor } = store();
    run(processor, { trace: '1', id: '1', startMs: 1_000, durationMs: 5, attributes: { 'http.route': '/a' } });
    run(processor, { trace: '2', id: '2', startMs: 2_000, durationMs: 50, status: SpanStatusCode.ERROR, attributes: { 'http.route': '/a' } });
    run(processor, { trace: '3', id: '3', startMs: 3_000, durationMs: 500, attributes: { 'http.route': '/b' } });

    expect(s.list({ route: '/a' }).items.map((t) => t.traceId)).to.deep.eq([traceIdOf('2'), traceIdOf('1')]);
    expect(s.list({ status: 'error' }).items.map((t) => t.traceId)).to.deep.eq([traceIdOf('2')]);
    expect(s.list({ minDurationMs: 40 }).items.map((t) => t.traceId)).to.deep.eq([traceIdOf('3'), traceIdOf('2')]);

    const first = s.list({ limit: 2 });
    expect(first.items.map((t) => t.traceId)).to.deep.eq([traceIdOf('3'), traceIdOf('2')]);
    expect(first.cursor).to.be.a('string');
    expect(s.list({ limit: 2, cursor: first.cursor }).items.map((t) => t.traceId)).to.deep.eq([traceIdOf('1')]);
  });
});
