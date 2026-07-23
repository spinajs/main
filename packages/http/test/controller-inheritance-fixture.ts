import { BaseController, BasePath, Get, Ok } from '../src/index.js';

/**
 * A controller declared in its OWN file, standing in for one shipped by a
 * package. Subclassed from the test file so `SourceFile` capture can be
 * checked across files - within a single file parent and child would share a
 * path and the assertion would prove nothing.
 */
@BasePath('pkg-in-other-file')
export class OtherFilePkgController extends BaseController {
  @Get()
  public async refresh() { return new Ok('pkg-refresh'); }

  public async resolve() { /* skip BaseController wiring - not needed here */ }
}
