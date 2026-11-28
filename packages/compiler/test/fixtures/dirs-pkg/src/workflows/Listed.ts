import { Workflow } from '../workflow-api.js';

@Workflow('listed')
export class Listed {
  public async run(): Promise<void> {}
}
