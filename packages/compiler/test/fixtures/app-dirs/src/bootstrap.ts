import { DI } from '@spinajs/di';
import { BaseController } from '@spinajs/http';
import { RegisteredController } from './elsewhere/RegisteredController.js';

DI.register(RegisteredController).as(BaseController);
