import { Injectable, Inject, Autoinject, Singleton, NewInstance, PerChildInstance, AsyncService, SyncService, Bootstrapper, LazyInject } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log-common';

export abstract class Mailer {}

@Injectable(Mailer)
@Singleton()
export class SmtpMailer extends Mailer {}

@Injectable()
@NewInstance()
export class Clock extends SyncService {}

@Inject(Clock)
@Injectable()
export class Greeter extends AsyncService {
  @Autoinject(Mailer) public mailer: Mailer;
  @Autoinject() public clock: Clock;
  @Autoinject(Mailer, { optional: true }) public optionalMailer?: Mailer;
  @Autoinject(Mailer) public allMailers: Mailer[];
  @Config('basic.greeting') public greeting: string;
  @Logger('basic') public log: Log;
  @LazyInject(Clock) public lazyClock: Clock;
  constructor(public clock2: Clock) { super(); }
}

@Injectable(Bootstrapper)
@PerChildInstance()
export class BasicBootstrapper extends Bootstrapper {
  public bootstrap(): void {}
}
