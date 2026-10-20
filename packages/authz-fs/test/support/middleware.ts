import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { FsMiddleware } from '@spinajs/fs';
import type { FsActionContext, fs } from '@spinajs/fs';

/** Adds `middleware` to the chain every fs action resolves from root; the returned function removes it. */
export function installFsMiddleware(middleware: FsMiddleware): () => void {
  // Array.ofType leaves factory registrations out of the collection, so the chain reaches the instance through a
  // registered class; its singleton is cached by class name, hence the uncache on both ends.
  class InstalledFsMiddleware extends FsMiddleware {
    public order = middleware.order;

    isEnabled(target: fs): boolean {
      return middleware.isEnabled ? middleware.isEnabled(target) : true;
    }

    before(ctx: FsActionContext): Promise<void> {
      return middleware.before(ctx);
    }

    after(ctx: FsActionContext, result: unknown): Promise<unknown> {
      return middleware.after ? middleware.after(ctx, result) : Promise.resolve(result);
    }
  }

  const uncache = () => {
    DI.uncache(InstalledFsMiddleware);
    DI.uncache(Array.ofType(FsMiddleware));
  };
  uncache();
  const undo = testHost.registerInRoot(FsMiddleware, InstalledFsMiddleware);
  return () => {
    undo();
    uncache();
  };
}
