import { BaseController } from '../../src/index.js';

export class Gated extends BaseController {
  public static readonly mountedBySource = true;
}

export class Plain extends BaseController {}
