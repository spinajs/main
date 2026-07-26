import { Schema } from '@spinajs/validation';
import { Relation } from './../../src/dto-relation.js';
import { User } from './../models/User.js';

@Schema({
  type: 'object',
  $id: 'orm-http.test.CampaignDTO',
  properties: {
    Name: { type: 'string' },
    author: { type: 'string' },
  },
})
export class CampaignDTO {
  public Name?: string;

  @Relation(() => User, { by: 'Uuid' })
  public author?: string;

  constructor(data: Partial<CampaignDTO>) {
    Object.assign(this, data);
  }
}

/**
 * The inherit-and-make-required workflow from the design: the subclass ships a
 * schema listing `author` as required; the @Relation descriptor is inherited.
 */
@Schema({
  type: 'object',
  $id: 'orm-http.test.StrictCampaignDTO',
  properties: {
    Name: { type: 'string' },
    author: { type: 'string' },
  },
  required: ['author'],
})
export class StrictCampaignDTO extends CampaignDTO {}
