import { IRouteParameter } from '../interfaces.js';

export abstract class ArgHydrator {
  public abstract hydrate(input: any, parameter: IRouteParameter): Promise<any>;
}
