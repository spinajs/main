export interface IConfiguratioDbSourceConfig {
  connection: string;
  table: string;
}

export interface IConfigurationEntry {
  Id: number;
  Slug: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Value: any;

  // top level name, it will be merged with config as this group name
  Group: string;

  // int, float, string, json, date, time, datetime, boolean
  // if json, it will be parset as such
  Type: 'int' | 'float' | 'string' | 'json' | 'date' | 'time' | 'datetime' | 'boolean';
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
    type?: 'int' | 'float' | 'string' | 'json' | 'date' | 'time' | 'datetime' | 'boolean';
  };
}
