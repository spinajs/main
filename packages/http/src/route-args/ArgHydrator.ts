export abstract class ArgHydrator {
  public abstract hydrate(input: any): Promise<any>;
}
