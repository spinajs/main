import { DateTime } from 'luxon';

export interface IConfiguratioDbSourceConfig {
  connection: string;
  table: string;
}

export type ConfigurationEntryType = 'int' | 'float' | 'string' | 'json' | 'date' | 'datetime' | 'time' | 'boolean' | 'time-range' | 'date-range' | 'datetime-range' | 'range' | 'oneOf' | 'manyOf';

export interface IConfigurationEntry {
  Id: number;
  Slug: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Value: any;

  // top level name, it will be merged with config as this group name
  Group: string;

  // int, float, string, json, date, time, datetime, boolean
  // if json, it will be parset as such
  Type: ConfigurationEntryType;
}

export interface IConfigurationEntryMeta {
  minDate?: DateTime;
  maxDate?: DateTime;

  min?: number;
  max?: number;

  oneOf?: string[];
  manyOf?: string[];
}

export interface IConfigEntryOptions {
  /**
   * Should value be exposed in db
   */
  expose?: boolean;

  /**
   * DB expose options
   */
  exposeOptions: {
    slug?: string;
    group?: string;
    type?: ConfigurationEntryType;
    meta?: IConfigurationEntryMeta;
    description?: string;
    label?: string;

    /**
     * Should we watch for config val change
     * Usefull if we dont need to restart app when value changes
     */
    watch?: boolean;
  };
}
