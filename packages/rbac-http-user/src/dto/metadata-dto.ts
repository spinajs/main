import { Schema } from '@spinajs/validation';

export const MetadataDtoSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'User metadata DTO',
    type: 'object',
    properties: {
        Key: { type: 'string', maxLength: 255, minLength: 6 },
        Value: { type: 'string' },
        Type: { type: "string", enum: ['number', 'float', 'string', 'json', 'boolean', 'datetime'] }
    },
    required: ['Key', 'Type'],
};

@Schema(MetadataDtoSchema)
export class UserMetadataDto {
    public Key : string;
    public Value : string;
    public Type: 'number' | 'float' | 'string' | 'json' | 'boolean' | 'datetime';
    constructor(data: any) {
        Object.assign(this, data);
    }
}
