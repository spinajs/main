import { publishedManifest } from '@spinajs/manifest';
import type { ControllerEntry, Manifest, SocketControllerEntry } from '@spinajs/manifest';
import { resolveReferences } from './dto-types.js';
import { controllerBase, controllerKey, routeModel, type RouteModel } from './routes.js';
import { emitContract } from './socket.js';
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
  /** Sealed: `used` already holds every schema the client and its contracts reach, and printing adds none. */
  ctx: TypeContext;
  controllers: ControllerModel[];
  /** The socket controllers the client includes; empty with `includeSocket: false`. */
  sockets: SocketControllerEntry[];
}

export interface BuildClientModelOptions {
  /** Default: true when the manifest has socket controllers. */
  includeSocket?: boolean;
}

export function buildClientModel(manifest: Manifest, options: BuildClientModelOptions = {}): ClientModel {
  const published = publishedManifest(manifest);
  const ctx = new TypeContext(published);
  const controllers = published.controllers
    .filter((c) => c.routes.length > 0)
    .sort((a, b) => a.className.localeCompare(b.className) || a.id.localeCompare(b.id))
    .map((entry) => ({ key: controllerKey(entry), base: controllerBase(entry), entry, routes: entry.routes.map((r) => routeModel(entry, r, ctx)) }));
  const includeSocket = options.includeSocket ?? published.socketControllers.length > 0;
  const sockets = includeSocket ? [...published.socketControllers].sort((a, b) => a.prefix.localeCompare(b.prefix) || a.id.localeCompare(b.id)) : [];
  // Printing a contract looks up its payload and result types, which records their schemas.
  for (const socket of sockets) emitContract(socket, ctx);
  resolveReferences(ctx);
  ctx.seal();
  return { manifestHash: published.hash, ctx, controllers, sockets };
}
