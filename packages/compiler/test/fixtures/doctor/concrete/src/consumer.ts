import { Autoinject, Inject, Injectable } from '@spinajs/di';

export class Plain {}
export abstract class Contract {}
export interface Shape {
  run(): void;
}

@Injectable()
@Inject(Plain, Contract)
export class Consumer {
  @Autoinject() public plain: Plain;
  @Autoinject() public contract: Contract;
  @Autoinject() public shape: Shape;
  @Autoinject({ check: true }) public checked: Plain;
  @Autoinject(Plain, { check: true }) public checkedExplicit: Plain;
  @Autoinject(Plain) public explicitPlain: Plain;
  @Autoinject(Plain) public all: Plain[];
}
