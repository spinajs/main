import { effectiveManifestOf } from '@spinajs/configuration';
import { Autoinject, Container, DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { ResourceNotFound } from '@spinajs/exceptions';
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import type { Manifest } from '@spinajs/manifest';

import type { StudioGraph } from '../contracts/index.js';
import { manifestDiGraph, mergeDiGraphs, resolveDiFocus, runtimeDiGraph, serviceDetail, svcId, tokenOf } from '../graph/di.js';
import { DepthQuery, MAX_GRAPH_LIMIT, graphView, viewOf } from '../graph/graph.js';
import { StudioAccess } from '../policies/StudioAccessPolicy.js';
import { LimitQuery, TextParam, TextQuery } from '../queries/params.js';

@BasePath({ config: 'studio.path', default: '/_studio' })
export class StudioDiController extends BaseController {
  @Autoinject(Container)
  protected Container: IContainer;

  /**
   * The DI graph: manifest and runtime merged when a manifest is loaded, else the runtime alone.
   *
   * @returns {StudioGraph} Nodes, edges, the source used and whether a limit cut it
   */
  @Get('api/di/graph')
  @StudioAccess('di')
  // `package` is a reserved word; http reads `_package` from `?package=`.
  public async graph(@TextQuery() focus?: string, @TextQuery() _package?: string, @DepthQuery() depth?: number, @LimitQuery(MAX_GRAPH_LIMIT) limit?: number) {
    const view = graphView({ focus, group: _package, depth, limit });
    const graph = this.fullGraph();
    if (view.focus === undefined) return new Ok(viewOf(graph, view));
    const node = resolveDiFocus(graph, view.focus);
    if (node === undefined) throw new ResourceNotFound(`no DI node ${view.focus}`);
    return new Ok(viewOf(graph, { ...view, focus: node }));
  }

  /**
   * One DI key: its implementations, who injects it and its manifest entries.
   *
   * @returns {DiServiceDetail} The service, by node id or bare key
   */
  @Get('api/di/services/:id')
  @StudioAccess('di')
  public async service(@TextParam() id: string) {
    const detail = serviceDetail(tokenOf(id), DI.RootContainer.describe(), this.manifest(), { asClass: id.startsWith(svcId('')) });
    if (!detail) throw new ResourceNotFound(`no DI key ${id}`);
    return new Ok(detail);
  }

  protected manifest(): Manifest | undefined {
    return effectiveManifestOf(this.Container)?.manifest;
  }

  protected fullGraph(): StudioGraph {
    // The root container: a controller resolved in a child scope sees none of the root singletons in its own registry.
    const runtime = runtimeDiGraph(DI.RootContainer.describe());
    const manifest = this.manifest();
    return manifest ? mergeDiGraphs(manifestDiGraph(manifest), runtime) : runtime;
  }
}
