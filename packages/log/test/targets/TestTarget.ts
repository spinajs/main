import { NewInstance } from '@spinajs/di';
import {  ICommonTargetOptions, ILogTargetData } from './../../src/types';
import { Injectable } from '@spinajs/di';
import { LogTarget } from './../../src/targets';

/**
 * Empty writer, usefull for tests or when we dont want to get any messages
 */
@NewInstance()
@Injectable("TestTarget")
export class TestTarget extends LogTarget<ICommonTargetOptions>
{
    public async write(data: ILogTargetData): Promise<void> {
        this.sink(this.format(data.Variables, this.Options.layout));
    }

    public sink(_msg: string) {
      
    }

}