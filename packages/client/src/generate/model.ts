import { publishedManifest } from '@spinajs/manifest';
import type { ControllerEntry, Manifest, SocketControllerEntry } from '@spinajs/manifest';
import { controllerBase, controllerKey, routeModel, type RouteModel } from './routes.js';
import { TypeContext } from './ts-type.js';

export type { ArgumentModel, RouteKind, RouteModel } from './routes.js';

export interface ControllerModel {
  key: string;
  base: string;
  entry: ControllerEntry;
  routes: RouteModel[];
}

/** The manifest as every generated file sees it: built once per run, then printed by each target. */
export interface ClientModel {
  manifestHash: string;
  /** Names, used schemas and TypeScript type expressions; printing records more used schemas in it. */
  ctx: TypeContext;
  controllers: ControllerModel[];
  sockets: SocketControllerEntry[];
}

export function buildClientModel(manifest: Manifest): ClientModel {
  const published = publishedManifest(manifest);
  const ctx = new TypeContext(published);
  const controllers = published.controllers
    .filter((c) => c.routes.length > 0)
    .sort((a, b) => a.className.localeCompare(b.className) || a.id.localeCompare(b.id))
    .map((entry) => ({ key: controllerKey(entry), base: controllerBase(entry), entry, routes: entry.routes.map((r) => routeModel(entry, r, ctx)) }));
  const sockets = [...published.socketControllers].sort((a, b) => a.prefix.localeCompare(b.prefix) || a.id.localeCompare(b.id));
  return { manifestHash: published.hash, ctx, controllers, sockets };
}
