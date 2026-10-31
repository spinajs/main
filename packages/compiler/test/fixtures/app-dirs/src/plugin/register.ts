import { DI } from '@spinajs/di';
import { BaseController } from '@spinajs/http';
import { AdminController } from './AdminController.js';

DI.register(AdminController).as(BaseController);
