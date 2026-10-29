import { AsyncService, DI, Injectable } from '@spinajs/di';

export class AuthzService extends AsyncService {}

@Injectable()
export class PrincipalMiddleware extends AsyncService {
  private authz: Promise<AuthzService> | undefined;

  protected rootService(): Promise<AuthzService> {
    this.authz ??= DI.resolve(AuthzService).catch((err: unknown) => {
      this.authz = undefined;
      throw err;
    });
    return this.authz;
  }

  protected async fixed(): Promise<AuthzService> {
    return await DI.resolve(AuthzService);
  }
}
