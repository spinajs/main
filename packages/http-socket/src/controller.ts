import { AsyncService } from '@spinajs/di';
import { ISocketControllerDescriptor, SOCKET_CONTROLLER_DESCRIPTOR } from './interfaces.js';

export abstract class BaseSocketController extends AsyncService {
  [member: string]: any;

  public get Descriptor(): ISocketControllerDescriptor | undefined {
    return Reflect.getMetadata(SOCKET_CONTROLLER_DESCRIPTOR, this) as ISocketControllerDescriptor | undefined;
  }
}
