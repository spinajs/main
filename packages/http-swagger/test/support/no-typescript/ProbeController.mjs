// Plain JavaScript so the probe runs without ts-node, which loads typescript itself; decorators are applied by hand.
import { BaseController, BasePath, Get, Ok, Query } from '@spinajs/http';

export class ProbeController extends BaseController {
  ping(value) {
    return new Ok({ value });
  }
}

Reflect.defineMetadata('design:paramtypes', [String], ProbeController.prototype, 'ping');
Query()(ProbeController.prototype, 'ping', 0);
Get('ping')(ProbeController.prototype, 'ping', Object.getOwnPropertyDescriptor(ProbeController.prototype, 'ping'));
BasePath('probe')(ProbeController);
