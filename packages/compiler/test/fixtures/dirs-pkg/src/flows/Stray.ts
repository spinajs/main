import { Workflow } from '../workflow-api.js';

@Workflow('stray')
export class Stray {
  public async run(): Promise<void> {}
}
