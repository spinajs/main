import { Log, Logger } from '@spinajs/log-common';
import { Autoinject } from '@spinajs/di';
import { Configuration } from "@spinajs/configuration-common";

export abstract class TranslationSource {
    @Autoinject()
    protected Configuration: Configuration;

    @Logger('intl')
    protected Log: Log;

    public abstract load(): Promise<{}>;
}