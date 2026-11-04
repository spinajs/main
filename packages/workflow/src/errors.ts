export class WorkflowNotRegistered extends Error {
  constructor(workflow: string, version?: number) {
    super(version === undefined ? `workflow '${workflow}' is not registered` : `workflow '${workflow}' version ${version} is not registered`);
    this.name = 'WorkflowNotRegistered';
  }
}

export class WorkflowNotFound extends Error {
  constructor(public readonly instanceId: string) {
    super(`workflow instance '${instanceId}' does not exist`);
    this.name = 'WorkflowNotFound';
  }
}

export class WorkflowIdConflict extends Error {
  constructor(id: string, existing: string, requested: string) {
    super(`workflow instance '${id}' already exists as '${existing}', not '${requested}'`);
    this.name = 'WorkflowIdConflict';
  }
}

export class DuplicateWorkflowDefinition extends Error {
  constructor(name: string, version: number, first: string, second: string) {
    super(`workflow '${name}' version ${version} is declared by ${first} and ${second}`);
    this.name = 'DuplicateWorkflowDefinition';
  }
}
