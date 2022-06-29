import { IRouteParameter } from '../interfaces';

export abstract class ArgHydrator {
  public abstract hydrate(input: any, parameter: IRouteParameter): Promise<any>;
}
