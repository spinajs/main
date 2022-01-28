import {  ICommonTargetOptions, ILogTargetData } from '../../src/types';
import {  Injectable, Singleton } from '@spinajs/di';
import { LogTarget } from '../../src/targets';

/**
 * Empty writer, usefull for tests or when we dont want to get any messages
 */
@Singleton()
@Injectable("TestLevel")
export class TestLevel extends LogTarget<ICommonTargetOptions>
{
    public async write(data: ILogTargetData): Promise<void> {
        this.sink(this.format(data.Variables, this.Options.layout));
    }

    public sink(_msg: string) {
      
    }

}