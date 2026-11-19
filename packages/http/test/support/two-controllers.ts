import { BaseController, BasePath, Get, Ok, Query } from '../../src/index.js';

/** Probes the device. */
@BasePath('probe')
export class ProbeController extends BaseController {
  /**
   * Reads one probe
   * @param probeId - id of the probe
   */
  @Get()
  public read(@Query() probeId: string) {
    return new Ok({ probeId });
  }
}

/** Something else entirely. */
@BasePath('other')
export class OtherController extends BaseController {
  /**
   * Reads one other thing
   * @param otherName - name of the other thing
   */
  @Get()
  public read(@Query() otherName: string) {
    return new Ok({ otherName });
  }
}
