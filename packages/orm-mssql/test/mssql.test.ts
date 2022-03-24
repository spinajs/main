import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import * as _ from 'lodash';
import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import { MsSqlOrmDriver } from './../src/index';

const expect = chai.expect;
chai.use(chaiAsPromised);
