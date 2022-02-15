import { ConfigVariable } from '@spinajs/configuration-common';
import { Injectable } from '@spinajs/di';
import { dirname } from 'path';
import { app } from 'electron';

/**
 * Common electron variables to use in
 * formatter
 */
@Injectable(ConfigVariable)
export class ElectronPathVariables extends ConfigVariable {
  public get Name(): string {
    return 'electron-path';
  }
  public Value(option?: string): string {
    switch (option) {
      case 'cwd':
        return dirname(app.getPath('exe'));
      default:
        return app.getPath(option as any);
    }
  }
}
