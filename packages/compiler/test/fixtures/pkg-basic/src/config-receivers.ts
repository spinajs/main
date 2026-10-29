import { Configuration } from '@spinajs/configuration';

export abstract class AppConfiguration extends Configuration {}
declare const sub: AppConfiguration;
declare const maybe: Configuration | undefined;

sub.get('basic.sub');
maybe?.get('basic.maybe');
