import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { Config } from '@spinajs/configuration';
import { ResourceNotFound } from '@spinajs/exceptions';
import { BaseController, BasePath, Get, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';

import { StudioAccess } from '../policies/StudioAccessPolicy.js';
import { StudioAssetResponse, StudioPageResponse, UI_MISSING, appBase, assetFile, locateUi, servedBase, uiSegments, withStudioBase } from '../ui/ui.js';

const NO_FILE = 'no such Studio file';

@BasePath({ config: 'studio.path', default: '/_studio' })
export class StudioUiController extends BaseController {
  @Config('studio.path', { defaultValue: '/_studio' })
  protected Path: string;

  @Config('studio.ui.path')
  protected UiPath: string | undefined;

  @Config('http.controllers.route.prefix')
  protected Prefix: string | undefined;

  private located?: { root: string; index: string; html: string } | null;

  /** The Studio UI. */
  @Get('/')
  @StudioAccess('ui')
  public async index(@Req() req: Request) {
    return this.serve(req);
  }

  /** The Studio UI: a file of its dist/, else index.html for a client-side route. */
  @Get('*path')
  @StudioAccess('ui')
  public async page(@Req() req: Request) {
    return this.serve(req);
  }

  // Only the path is read from the request: these two routes take no query and no body. `req.path` keeps the escapes,
  // which `uiSegments` decodes one segment at a time.
  protected serve(req: Request) {
    const base = servedBase(this.Path, this.Prefix);
    // The router matches case-insensitively, so the base is compared the same way.
    const below = req.path.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? req.path.slice(base.length + 1) : '';
    const segments = uiSegments(below);
    if (!segments) throw new ResourceNotFound(NO_FILE);
    if (segments[0]?.toLowerCase() === 'api') throw new ResourceNotFound('no such Studio API route');

    const ui = this.ui(base);
    if (!ui) throw new ResourceNotFound(UI_MISSING);
    const path = segments.join('/');
    if (path === '' || path === 'index.html') return new StudioPageResponse(ui.html);

    const file = assetFile(ui.root, path);
    if (file === null) throw new ResourceNotFound(NO_FILE);
    // A case-insensitive file system finds index.html as INDEX.HTML too; it must get the base all the same. The JS
    // real path keeps the requested case, and `relative` compares case-insensitively on Windows.
    if (file === undefined || relative(ui.index, file) === '') return new StudioPageResponse(ui.html);
    return new StudioAssetResponse(ui.root, file, segments[0] === 'assets');
  }

  // Read once: dist/ is immutable for the life of the process.
  protected ui(base: string): { root: string; index: string; html: string } | undefined {
    if (this.located === undefined) {
      const root = locateUi(this.UiPath);
      const index = root ? assetFile(root, 'index.html') : undefined;
      this.located = root && index ? { root, index, html: withStudioBase(readFileSync(index, 'utf8'), base, appBase(this.Prefix)) } : null;
    }
    return this.located ?? undefined;
  }
}
