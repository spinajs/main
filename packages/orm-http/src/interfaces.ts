import { Schema } from '@spinajs/validation';

@Schema('http://json-schema.org/draft-07/schema#')
export class JsonApiIncomingObject {
  public data: {
    type: string;
    id: string;
    attributes: any;
    relationships: any;
  } = null;

  constructor(data: any) {
    Object.assign(this, data);
  }
}
