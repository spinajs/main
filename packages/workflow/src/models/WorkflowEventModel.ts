import { Connection, Json, Model, ModelBase, Primary } from '@spinajs/orm';
import type { EventState } from '../contract.js';
import { WORKFLOW_CONNECTION } from '../workflow-config.js';
import { Int8 } from './converters.js';

@Connection(WORKFLOW_CONNECTION)
@Model('__workflow_event')
export class WorkflowEventModel extends ModelBase {
  /** BIGINT: Postgres hands it back as a string, so read it through `Number()`. */
  @Primary()
  public Id: number | string;

  public InstanceId: string;

  public Name: string;

  @Json()
  public Payload: unknown;

  public Principal: string | null;

  public DedupKey: string | null;

  public State: EventState;

  public ConsumedByKey: string | null;

  @Int8()
  public ReceivedAt: number;
}
