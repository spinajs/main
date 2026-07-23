import { BaseController, BasePath, Put, Body, Ok } from '@spinajs/http';
import { FromModel } from './../../src/index.js';
import { Campaign } from './../models/Campaign.js';
import { CampaignDTO, StrictCampaignDTO } from './../dto/CampaignDTO.js';

@BasePath('campaign')
export class CampaignController extends BaseController {
  @Put(':campaign')
  public async update(@FromModel() campaign: Campaign, @Body() dto: CampaignDTO) {
    // dto.author is declared as the wire type (string uuid) but holds the
    // resolved User model at runtime; the ORM hydrators translate it to the FK.
    await campaign.update(dto as unknown as Partial<Campaign>);
    return new Ok(campaign.dehydrate({ skipUndefined: true }));
  }

  @Put('strict/:campaign')
  public async updateStrict(@FromModel() campaign: Campaign, @Body() dto: StrictCampaignDTO) {
    await campaign.update(dto as unknown as Partial<Campaign>);
    return new Ok(campaign.dehydrate({ skipUndefined: true }));
  }
}
