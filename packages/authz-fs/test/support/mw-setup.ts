import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Principal } from '@spinajs/authz';
import { userPrincipal } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';
import { fsNative } from '@spinajs/fs';
import type { IFsLocalOptions } from '@spinajs/fs';
import { renderTemplate } from '@spinajs/log-common';

import { AuthzFsMiddleware } from '../../src/index.js';
import type { AuthzFsMiddlewareOptions } from '../../src/index.js';
import { configuredChild } from '../helpers.js';
import { FakeAuthz } from './fake-authz.js';
import { installQuietLog } from './log.js';
import { MemoryFileAclStore } from './memory-acl-store.js';
import { installFsMiddleware } from './middleware.js';

const logLine = (fields: unknown, template?: unknown): string => (typeof fields === 'string' ? fields : renderTemplate(template as string, fields as Record<string, unknown>));

export interface MwSetup {
  dir: string;
  child: IContainer;
  authz: FakeAuthz;
  acl: MemoryFileAclStore;
  principal: Principal;
  readonly warnings: string[];
  readonly errors: string[];
  /** A fresh directory `<dir>/<name>` holding `files`. */
  base(name: string, files?: Readonly<Record<string, string>>): string;
  /** fsNative named `name` over base(name, files). */
  local(name: string, files?: Readonly<Record<string, string>>): fsNative<IFsLocalOptions>;
  /** The middleware the suite installs: the case's FakeAuthz, principal, log and MemoryFileAclStore. */
  middleware(more?: Partial<AuthzFsMiddlewareOptions>): AuthzFsMiddleware;
  /** Replaces the installed middleware for the rest of the case. */
  use(middleware: AuthzFsMiddleware): void;
}

/**
 * Mocha hooks for the middleware suites: per case a temp dir, a child Configuration with `entries` as `authz.fs`,
 * a FakeAuthz allowing everything, a MemoryFileAclStore, alice as the principal, and one AuthzFsMiddleware in the
 * root chain. Filesystem names start with `mw-`, so the AuthzFsMiddleware that authz-fs registers in root (it reads
 * the root Configuration) never enables itself for them.
 */
export function useMiddleware(entries: Record<string, unknown>, extra: () => Partial<AuthzFsMiddlewareOptions> = () => ({})): MwSetup {
  let undo: (() => void) | undefined;
  let undoLog: (() => void) | undefined;
  const s = {
    warnings: [] as string[],
    errors: [] as string[],
    base(name: string, files: Readonly<Record<string, string>> = {}): string {
      const basePath = join(s.dir, name);
      mkdirSync(basePath, { recursive: true });
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(basePath, path, '..'), { recursive: true });
        writeFileSync(join(basePath, path), content);
      }
      return basePath;
    },
    local(name: string, files: Readonly<Record<string, string>> = {}): fsNative<IFsLocalOptions> {
      return new fsNative<IFsLocalOptions>({ name, basePath: s.base(name, files) });
    },
    middleware(more: Partial<AuthzFsMiddlewareOptions> = {}): AuthzFsMiddleware {
      return new AuthzFsMiddleware({
        container: s.child,
        service: async () => s.authz,
        principal: () => s.principal,
        log: {
          warn: (fields: unknown, template?: unknown) => void s.warnings.push(logLine(fields, template)),
          error: (fields: unknown, template?: unknown) => void s.errors.push(logLine(fields, template)),
        },
        store: async () => s.acl,
        ...extra(),
        ...more,
      });
    },
    use(middleware: AuthzFsMiddleware): void {
      undo?.();
      undo = installFsMiddleware(middleware);
    },
  } as MwSetup;

  before(() => {
    undoLog = installQuietLog();
  });

  after(() => {
    undoLog?.();
  });

  beforeEach(async () => {
    s.dir = mkdtempSync(join(tmpdir(), 'authz-fs-mw-'));
    s.child = await configuredChild(entries);
    s.authz = new FakeAuthz();
    s.acl = new MemoryFileAclStore();
    s.principal = userPrincipal('alice');
    s.warnings.length = 0;
    s.errors.length = 0;
    s.use(s.middleware());
  });

  afterEach(async () => {
    undo?.();
    undo = undefined;
    await s.child.dispose();
    rmSync(s.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  return s;
}
