import { Schema } from '@spinajs/validation';

@Schema('http://json-schema.org/draft-06/schema#')
export class JsonApiIncomingObject {
  public data: {
    type: string;
    id: string;
    attributes: any;
    relationships: any;
  } = null;
}
