import { Workflow } from '../workflow-api.js';

@Workflow('internal')
class Internal {
  public async run(): Promise<void> {}
}
