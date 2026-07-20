import { Injectable } from '@spinajs/di';
import { tmpdir, homedir, hostname, userInfo, platform as osPlatform, arch as osArch } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ConfigVariable } from './variables-common.js';

@Injectable(ConfigVariable)
export class EnvVariable extends ConfigVariable {
  public get Name(): string {
    return 'env';
  }
  public Value(option: string): string {
    return process.env[`${option}`] ?? '';
  }
}

/**
 * Resolves a cross-platform user directory (config/data/cache) following
 * OS conventions: Windows AppData, macOS ~/Library, XDG on Linux/others.
 */
function userDir(kind: 'config' | 'data' | 'cache'): string {
  const home = homedir();
  switch (osPlatform()) {
    case 'win32': {
      const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
      const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
      return kind === 'config' ? appData : localAppData;
    }
    case 'darwin': {
      const library = join(home, 'Library');
      return kind === 'cache' ? join(library, 'Caches') : join(library, 'Application Support');
    }
    default: {
      if (kind === 'data') {
        return process.env.XDG_DATA_HOME ?? join(home, '.local', 'share');
      }
      if (kind === 'cache') {
        return process.env.XDG_CACHE_HOME ?? join(home, '.cache');
      }
      return process.env.XDG_CONFIG_HOME ?? join(home, '.config');
    }
  }
}

@Injectable(ConfigVariable)
export class PathVariable extends ConfigVariable {
  public get Name(): string {
    return 'path';
  }
  public Value(option?: string): string {
    switch (option) {
      case 'temp':
        return tmpdir();
      case 'home':
        return homedir();
      case 'cwd':
        return process.cwd();
      // 'appdata' kept as a cross-platform alias of the user config dir
      // (on Windows this is still %APPDATA%, but non-empty elsewhere too)
      case 'appdata':
      case 'config':
        return userDir('config');
      case 'data':
        return userDir('data');
      case 'cache':
        return userDir('cache');
      default:
        return '';
    }
  }
}

@Injectable(ConfigVariable)
export class HostnameVariable extends ConfigVariable {
  public get Name(): string {
    return 'hostname';
  }
  public Value(): string {
    return hostname();
  }
}

@Injectable(ConfigVariable)
export class UserVariable extends ConfigVariable {
  public get Name(): string {
    return 'user';
  }
  public Value(): string {
    return userInfo().username;
  }
}

@Injectable(ConfigVariable)
export class PlatformVariable extends ConfigVariable {
  public get Name(): string {
    return 'platform';
  }
  public Value(): string {
    return osPlatform();
  }
}

@Injectable(ConfigVariable)
export class ArchVariable extends ConfigVariable {
  public get Name(): string {
    return 'arch';
  }
  public Value(): string {
    return osArch();
  }
}

@Injectable(ConfigVariable)
export class CwdVariable extends ConfigVariable {
  public get Name(): string {
    return 'cwd';
  }
  public Value(): string {
    return process.cwd();
  }
}

@Injectable(ConfigVariable)
export class PidVariable extends ConfigVariable {
  public get Name(): string {
    return 'pid';
  }
  public Value(): string {
    return String(process.pid);
  }
}

@Injectable(ConfigVariable)
export class UuidVariable extends ConfigVariable {
  public get Name(): string {
    return 'uuid';
  }
  public Value(): string {
    return randomUUID();
  }
}
