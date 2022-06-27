import { ArgHydrator, Hydrator } from '../../src';

export class CustomArgHydrator extends ArgHydrator {
  public async hydrate(input: any): Promise<any> {
    const instance = new TestHydrator();
    instance.Id = `${input.Id}`;
    return instance;
  }
}

@Hydrator(CustomArgHydrator)
export class TestHydrator {
  public Id: string;
}
