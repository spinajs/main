import { IOFail, InvalidArgument } from '@spinajs/exceptions';
import { EmailRenderer } from '../interfaces';
// import * as fs from 'fs';
// import * as pugTemplate from 'pug';
import _ from 'lodash';

export class PugRenderer implements EmailRenderer {
  render(template: string, model: unknown): Promise<string> {
    if (!template) {
      throw new InvalidArgument('template parameter cannot be null or empty');
    }

    if (!fs.existsSync(template)) {
      throw new IOFail(`Template file ${template} not exists`);
    }

    // const content = pugTemplate.renderFile(
    //   template,
    //   _.merge(model, {
    //     __: __translate(language),
    //     __n: __translateNumber(language),
    //     __l: __translateL,
    //     __h: __translateH,
    //   }),
    // );
  }
}
