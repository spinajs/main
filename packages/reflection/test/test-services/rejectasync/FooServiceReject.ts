import { AsyncService } from '@spinajs/di';

export class FooServiceReject extends AsyncService {
  public resolve(): Promise<void> {
    return Promise.reject(new Error('cannot start'));
  }
}
