import 'mocha';
import { expect } from 'chai';
import { Container, DI, Inject } from '@spinajs/di';
import type { ContainerDescription } from '@spinajs/di';
import type { ServiceEntry } from '@spinajs/manifest';
import { sourceRef, testManifest } from '@spinajs/testing';

import type { DiServiceDetail, StudioGraph } from '../src/contracts/index.js';
import { edgeId, viewOf } from '../src/graph/graph.js';
import { manifestDiGraph, mergeDiGraphs, resolveDiFocus, runtimeDiGraph, serviceDetail, svcId, tokId, tokenOf } from '../src/graph/di.js';
import { MAX_ATTRIBUTE_BYTES } from '../src/span.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { registerHeaderSource } from './support/principals.js';

abstract class Contract {}
class Dep {}
@Inject(Dep)
class Both extends Contract {
  public constructor(public readonly dep: Dep) {
    super();
  }
}
class RuntimeOnly {}

// The shape the compiler writes (checked against the built lib/manifest.fragment.json files): `id` is
// `<package>:<class>`, `registeredAs` holds the class itself after asSelf, `lazy` appears only when true.
const service = (partial: Partial<ServiceEntry> & Pick<ServiceEntry, 'className'>): ServiceEntry => ({
  id: `fixture:${partial.className}`,
  registeredAs: [partial.className],
  lifetime: 'singleton',
  async: false,
  bootstrapper: false,
  ctorInjects: [],
  propertyInjects: [],
  source: sourceRef(`src/${partial.className}.ts`, 'fixture'),
  ...partial,
});

const manifest = testManifest({
  services: [
    service({ className: 'Both', registeredAs: ['Contract', 'Both'], ctorInjects: ['Dep'], imperativeResolves: [{ token: 'Dep', method: 'run', awaited: true, source: sourceRef('src/Both.ts', 'fixture') }] }),
    service({ className: 'Dep' }),
    service({ className: 'ManifestOnly', propertyInjects: [{ property: 'dep', token: 'Dep', optional: false, array: false, lazy: true }] }),
  ],
});

function runtimeContainer(): Container {
  const c = new Container();
  c.register(Both).as(Contract);
  c.register(Both).asSelf();
  c.register(Dep).asSelf();
  c.register(RuntimeOnly).asSelf();
  c.resolve(Both);
  return c;
}

const node = (g: StudioGraph, id: string) => g.nodes.find((n) => n.id === id);
const hasEdge = (g: StudioGraph, source: string, kind: string, target: string, label?: string) => g.edges.some((e) => e.id === edgeId(source, kind, target, label));
const merged = () => mergeDiGraphs(manifestDiGraph(manifest), runtimeDiGraph(runtimeContainer().describe()));

describe('DI graph', () => {
  it('builds the runtime graph from Container.describe()', () => {
    const g = runtimeDiGraph(runtimeContainer().describe());
    expect(g.source).to.eq('runtime');
    expect(node(g, svcId('Both'))?.attributes).to.include({ instantiated: true, lifetime: 'singleton' });
    expect(hasEdge(g, svcId('Both'), 'implements', tokId('Contract'))).to.eq(true);
    expect(hasEdge(g, svcId('Both'), 'ctor', svcId('Dep'))).to.eq(true);
    expect(node(g, tokId('Both'))).to.eq(undefined);
  });

  it('builds the manifest graph with groups, lazy and imperative edges', () => {
    const g = manifestDiGraph(manifest);
    expect(g.source).to.eq('manifest');
    expect(node(g, svcId('Both'))?.group).to.eq('fixture');
    expect(hasEdge(g, svcId('ManifestOnly'), 'lazy', svcId('Dep'), 'dep')).to.eq(true);
    expect(hasEdge(g, svcId('Both'), 'imperative', svcId('Dep'), 'run()')).to.eq(true);
  });

  it('merges: manifest-only nodes are not instantiated, runtime-only nodes are unknown to the manifest', () => {
    const g = merged();
    expect(g.source).to.eq('merged');
    expect(node(g, svcId('ManifestOnly'))?.attributes.instantiated).to.eq(false);
    expect(node(g, svcId('RuntimeOnly'))?.attributes.unknownToManifest).to.eq(true);
    expect(node(g, svcId('Both'))?.attributes).to.include({ instantiated: true, manifestId: 'fixture:Both' });
    expect(hasEdge(g, svcId('Both'), 'imperative', svcId('Dep'), 'run()')).to.eq(true);
  });

  it('maps a node id back to its DI key', () => {
    expect(['svc:Both', 'tok:Contract', 'val:settings', 'fac:Contract:0', 'Both'].map(tokenOf)).to.deep.eq(['Both', 'Contract', 'settings', 'Contract', 'Both']);
  });

  it('resolves a focus given as a node id or a bare key, and nothing else', () => {
    const g = merged();
    expect(resolveDiFocus(g, 'Both')).to.eq(svcId('Both'));
    expect(resolveDiFocus(g, 'Contract')).to.eq(tokId('Contract'));
    expect(resolveDiFocus(g, svcId('Dep'))).to.eq(svcId('Dep'));
    expect(resolveDiFocus(g, 'Nope')).to.eq(undefined);
  });

  it('returns the N-hop neighbourhood of a focus node, edges inside it only', () => {
    const g = merged();
    const one = viewOf(g, { focus: svcId('Both'), depth: 1 });
    expect(one.nodes.map((n) => n.id)).to.have.members([svcId('Both'), tokId('Contract'), svcId('Dep')]);
    expect(one.edges.every((e) => one.nodes.some((n) => n.id === e.source) && one.nodes.some((n) => n.id === e.target))).to.eq(true);
    expect(viewOf(g, { focus: svcId('Both'), depth: 2 }).nodes.map((n) => n.id)).to.include(svcId('ManifestOnly'));
  });

  it('truncates past the limit, nearest nodes first, and filters by package', () => {
    const g = merged();
    const capped = viewOf(g, { focus: svcId('Both'), depth: 3, limit: 2 });
    expect(capped.nodes[0].id).to.eq(svcId('Both'));
    expect(capped.nodes).to.have.length(2);
    expect(capped.truncated).to.eq(true);
    expect(viewOf(g, { group: 'fixture' }).nodes.map((n) => n.id)).to.have.members([svcId('Both'), svcId('Dep'), svcId('ManifestOnly')]);
  });

  it('describes one service with the classes that inject it and its manifest entries', () => {
    const detail = serviceDetail('Dep', runtimeContainer().describe(), manifest);
    expect(detail).to.deep.include({ token: 'Dep', source: 'merged', runtime: { resolving: false } });
    expect(detail?.injectedBy).to.deep.include.members([{ token: 'Both', kind: 'ctor' }, { token: 'ManifestOnly', kind: 'lazy' }]);
    expect(detail?.manifest.map((m) => m.id)).to.deep.eq(['fixture:Dep']);
    expect(detail?.sourceRef?.file).to.eq('src/Dep.ts');
    expect(serviceDetail('Nope', runtimeContainer().describe(), manifest)).to.eq(undefined);
  });

  it('takes the injections of a class the runtime could not read from its manifest entry', () => {
    const description: ContainerDescription = {
      services: [{ token: 'ManifestOnly', resolving: false, implementations: [{ name: 'ManifestOnly', kind: 'class', lifetime: 'singleton', instantiated: false, async: false, injects: [], error: 'property dep has no type' }] }],
    };
    const [implementation] = serviceDetail('ManifestOnly', description, manifest)?.implementations ?? [];
    expect(implementation.error).to.eq('property dep has no type');
    expect(implementation.injects).to.deep.eq([{ token: 'Dep', kind: 'lazy', optional: false, array: false, property: 'dep' }]);
  });

  it('cuts every name and path at 2 KiB, in the graph and in a service detail', () => {
    const long = 'L'.repeat(3000);
    const description: ContainerDescription = {
      services: [{ token: 'Long', resolving: false, implementations: [{ name: long, kind: 'class', lifetime: 'singleton', instantiated: false, async: false, injects: [{ token: long, kind: 'property', optional: false, array: false, property: long }], error: long }] }],
    };
    const longest = (value: unknown) => Math.max(...JSON.stringify(value).split('"').map((s) => s.length));
    const graph = mergeDiGraphs(manifestDiGraph(testManifest({ services: [service({ className: long, source: sourceRef(long, long) })] })), runtimeDiGraph(description));
    // An edge id joins three cut parts; each part is bounded.
    expect(longest([graph.nodes, graph.edges.map((e) => [e.source, e.target, e.label])])).to.be.within(MAX_ATTRIBUTE_BYTES, MAX_ATTRIBUTE_BYTES + 32);
    const entries = testManifest({ services: [service({ className: 'Long', registeredAs: ['Long', long], ctorInjects: [long], source: sourceRef(long, long) })] });
    expect(longest(serviceDetail('Long', description, entries))).to.be.within(MAX_ATTRIBUTE_BYTES, MAX_ATTRIBUTE_BYTES + 32);
  });
});

class StudioDiProbe {}
@Inject(StudioDiProbe)
class StudioDiConsumer {
  public constructor(public readonly probe: StudioDiProbe) {}
}

describe('GET /_studio/api/di', function () {
  this.timeout(30000);

  let app: TestApp;
  let unregister: () => void;
  const get = (path: string, user = 'bob') => app.request().get(path).set('Accept', 'application/json').set('x-user', user);

  before(async () => {
    unregister = registerHeaderSource();
    DI.register(StudioDiProbe).asSelf();
    DI.register(StudioDiConsumer).asSelf();
    DI.register({ password: 'studio-di-secret' }).asValue('StudioDiSettings');
    app = await startApp();
  });

  after(async () => {
    await stopApp();
    DI.RootContainer.Registry.removeValue('StudioDiSettings');
    DI.unregister(StudioDiConsumer);
    DI.unregister(StudioDiProbe);
    unregister();
  });

  it('answers the runtime graph around a focus', async () => {
    const res = await get('/_studio/api/di/graph?focus=StudioDiConsumer&depth=1');
    expect(res.status).to.eq(200);
    const g = res.body as StudioGraph;
    expect(g.source).to.eq('runtime');
    expect(g.nodes.map((n) => n.id)).to.have.members([svcId('StudioDiConsumer'), svcId('StudioDiProbe')]);
  });

  it('lists a registered value by its key, never its content', async () => {
    const res = await get(`/_studio/api/di/graph?limit=5000`);
    expect((res.body as StudioGraph).nodes.map((n) => n.id)).to.include('val:StudioDiSettings');
    expect(res.text).to.not.include('studio-di-secret');
    expect((await get('/_studio/api/di/services/StudioDiSettings')).text).to.not.include('studio-di-secret');
  });

  it('answers 404 for an unknown focus and 400 for an argument outside its schema', async () => {
    const tooLong = 'x'.repeat(513);
    const paths = ['graph?focus=NoSuchService', 'graph?focus=StudioDiProbe&depth=99', 'graph?depth=1', 'graph?limit=0', 'graph?limit=5001', `graph?focus=${tooLong}`, `graph?package=${tooLong}`, `services/${tooLong}`];
    const statuses: number[] = [];
    for (const path of paths) statuses.push((await get(`/_studio/api/di/${path}`)).status);
    expect(statuses).to.deep.eq([404, 400, 400, 400, 400, 400, 400, 400]);
  });

  it('answers one service by key or by node id', async () => {
    const res = await get('/_studio/api/di/services/StudioDiProbe');
    expect(res.status).to.eq(200);
    const detail = res.body as DiServiceDetail;
    expect(detail).to.deep.include({ token: 'StudioDiProbe', source: 'runtime', injectedBy: [{ token: 'StudioDiConsumer', kind: 'ctor' }], manifest: [] });
    expect((await get(`/_studio/api/di/services/${encodeURIComponent(svcId('StudioDiProbe'))}`)).body).to.deep.eq(detail);
    expect((await get('/_studio/api/di/services/NoSuchService')).status).to.eq(404);
  });

  it('refuses a caller without the di permission on both routes', async () => {
    const graph = await get('/_studio/api/di/graph', 'alice');
    const detail = await get('/_studio/api/di/services/StudioDiProbe', 'alice');
    expect([graph.status, detail.status]).to.deep.eq([403, 403]);
  });
});
