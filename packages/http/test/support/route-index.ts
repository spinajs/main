import { AsyncLocalStorage } from 'node:async_hooks';
import express from 'express';
import { DI } from '@spinajs/di';

import { BaseController } from '../../src/base-controller.js';
import { buildRoutePath } from '../../src/route-builder.js';
import type { RouteIndex } from '../../src/route-index.js';

const noop = () => undefined;
const noopLog = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, security: noop, success: noop };
const NEXT: express.RequestHandler = (_req, _res, next) => next();

const roots = new WeakMap<RouteIndex, express.Router>();

/** A controller as the route builder sees it, reading `values` as its configuration. */
export function controller<T extends BaseController>(type: new () => T, values: Record<string, unknown> = {}): T {
  const c = new type();
  const cfg = { get: (path: string, fallback?: unknown) => (path in values ? values[path] : fallback) };
  for (const [name, value] of Object.entries({ _cfg: cfg, _log: noopLog, _container: DI, _actionLocalStorage: new AsyncLocalStorage() })) {
    Object.defineProperty(c, name, { value });
  }
  return c;
}

/**
 * Mounts the routes of `controllers`, behind `prefix`, as `Controllers` and `BaseController.resolve()` do: one router per
 * controller on the index's root router, in the given order, every route a no-op.
 */
export function mountRoutes(index: RouteIndex, controllers: readonly BaseController[], prefix?: string): void {
  let root = roots.get(index);
  if (!root) {
    root = express.Router();
    roots.set(index, root);
    index.mount(root);
  }
  for (const c of controllers) {
    const router = express.Router();
    for (const [, route] of c.Descriptor.Routes) {
      const path = buildRoutePath(c.BasePath, route, prefix);
      const mounted = router.route(path);
      (mounted as unknown as Record<string, (h: express.RequestHandler) => void>)[String(route.InternalType)](NEXT);
      index.add(mounted, c, route, path);
    }
    root.use(router);
    index.mounted();
  }
}
