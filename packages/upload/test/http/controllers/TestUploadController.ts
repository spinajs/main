import { Forbidden } from '@spinajs/exceptions';
import { BasePath, Policy } from '@spinajs/http';
import type { Request } from '@spinajs/http';

import { UploadController } from '../../../src/http/index.js';
import type { CreateUploadDto, UploadAction } from '../../../src/http/index.js';
import type { AllowedTypes, UploadSession } from '../../../src/index.js';
import { Seen } from '../support/calls.js';
import { HeaderPolicy } from '../support/policy.js';

const header = (req: Request, name: string): string | undefined => {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
};

const projectOf = (req: Request): string => {
  const value = req.params.project;
  return typeof value === 'string' ? value : '';
};

/**
 * The app side of the contract, driven by headers:
 * - x-test-owner: the owner
 * - x-test-deny: the action that authorize refuses
 * - x-test-policy: deny, which makes the class policy refuse
 * - x-test-unknown-type: allow
 */
@BasePath('projects/:project/uploads')
@Policy(HeaderPolicy)
export class TestUploadController extends UploadController {
  protected async authorize(action: UploadAction, req: Request, session?: UploadSession): Promise<void> {
    Seen.authorized.push({ action, session: session?.id ?? null });
    if (header(req, 'x-test-deny') === action) throw new Forbidden(`${action} refused by the test`);
  }

  protected async ownerOf(req: Request): Promise<string | null> {
    return header(req, 'x-test-owner') ?? null;
  }

  protected async metadataFor(req: Request, dto: CreateUploadDto): Promise<Record<string, unknown>> {
    return { ...(dto.metadata ?? {}), project: projectOf(req) };
  }

  protected async allowedTypes(_req: Request): Promise<AllowedTypes> {
    return ['text/plain'];
  }

  protected async allowUnknownType(req: Request): Promise<boolean> {
    return header(req, 'x-test-unknown-type') === 'allow';
  }

  protected async onCompleted(session: UploadSession, req: Request): Promise<unknown> {
    Seen.hooks.push({ hook: 'onCompleted', id: session.id, status: session.status, project: projectOf(req) });
    if (Seen.failCompletions > 0) {
      Seen.failCompletions--;
      throw new Error('onCompleted failed in the test');
    }
    return undefined;
  }

  protected async onAborted(session: UploadSession, req: Request): Promise<void> {
    Seen.hooks.push({ hook: 'onAborted', id: session.id, status: session.status, project: projectOf(req) });
  }
}
