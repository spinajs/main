import { AsyncService, Injectable, Singleton, type Constructor } from '@spinajs/di';
import { parseDuration } from '@spinajs/durable';
import { InvalidArgument } from '@spinajs/exceptions';
import { ListFromFiles, SCAN_GLOB } from '@spinajs/reflection';
import type { WorkflowContext, WorkflowOptions } from './contract.js';
import { DuplicateWorkflowDefinition, WorkflowNotRegistered } from './errors.js';

export abstract class WorkflowDefinition<TInput = unknown, TResult = unknown> {
  public abstract run(ctx: WorkflowContext<TInput>): Promise<TResult>;
}

export interface WorkflowDeclaration {
  name: string;
  options: WorkflowOptions;
  target: Constructor<WorkflowDefinition>;
}

export interface RegisteredWorkflow {
  name: string;
  version: number;
  options: WorkflowOptions;
  target: Constructor<WorkflowDefinition>;
  timeoutMs: number | null;
}

const DECLARATIONS: WorkflowDeclaration[] = [];
const MAX_NAME = 128;

export function defineWorkflow(target: Constructor<WorkflowDefinition>, name: string, options: WorkflowOptions = {}): void {
  DECLARATIONS.push({ name, options, target });
}

export function undefineWorkflow(name: string): void {
  const kept = DECLARATIONS.filter((d) => d.name !== name);
  DECLARATIONS.splice(0, DECLARATIONS.length, ...kept);
}

export function Workflow(name: string, options?: WorkflowOptions): ClassDecorator {
  return (target) => defineWorkflow(target as unknown as Constructor<WorkflowDefinition>, name, options);
}

function normalize(d: WorkflowDeclaration): RegisteredWorkflow {
  if (d.name.length === 0 || d.name.length > MAX_NAME) {
    throw new InvalidArgument(`workflow name must be 1..${MAX_NAME} characters, got '${d.name.slice(0, 40)}'`);
  }
  const version = d.options.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new InvalidArgument(`workflow '${d.name}': version must be an integer >= 1, got ${version}`);
  }
  const timeoutMs = d.options.timeout === undefined ? null : parseDuration(d.options.timeout, `workflow '${d.name}' timeout`);
  return { name: d.name, version, options: d.options, target: d.target, timeoutMs };
}

@Singleton()
@Injectable()
export class WorkflowRegistry extends AsyncService {
  // Listing the files imports them, which runs their @Workflow decorators.
  @ListFromFiles(SCAN_GLOB, 'system.dirs.workflows')
  protected WorkflowFiles: Promise<unknown[]>;

  protected byKey = new Map<string, RegisteredWorkflow>();

  public async resolve(): Promise<void> {
    await this.WorkflowFiles;
    const byKey = new Map<string, RegisteredWorkflow>();
    for (const d of DECLARATIONS) {
      const w = normalize(d);
      const key = `${w.name}@${w.version}`;
      const existing = byKey.get(key);
      if (existing && existing.target !== w.target) {
        throw new DuplicateWorkflowDefinition(w.name, w.version, existing.target.name, w.target.name);
      }
      byKey.set(key, w);
    }
    this.byKey = byKey;
    await super.resolve();
  }

  public all(): RegisteredWorkflow[] {
    return [...this.byKey.values()];
  }

  public find(name: string, version: number): RegisteredWorkflow | undefined {
    return this.byKey.get(`${name}@${version}`);
  }

  public latest(name: string): RegisteredWorkflow | undefined {
    let best: RegisteredWorkflow | undefined;
    for (const w of this.byKey.values()) if (w.name === name && (!best || w.version > best.version)) best = w;
    return best;
  }

  public forClass(target: Constructor<unknown>): RegisteredWorkflow | undefined {
    for (const w of this.byKey.values()) if (w.target === target) return w;
    return undefined;
  }

  public resolveForStart(workflow: string | Constructor<unknown>, version?: number): RegisteredWorkflow {
    if (typeof workflow !== 'string') {
      const own = this.forClass(workflow);
      if (!own) throw new WorkflowNotRegistered(workflow.name);
      return own;
    }
    const found = version === undefined ? this.latest(workflow) : this.find(workflow, version);
    if (!found) throw new WorkflowNotRegistered(workflow, version);
    return found;
  }
}
