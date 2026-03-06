/**
 * Cursor IDE user data / state.vscdb path resolution for quota fetching.
 *
 * CLI may run in multiple environments (local macOS/Linux/Windows, SSH, devcontainer,
 * Codespaces). Cursor's data directory varies by platform; use env overrides when
 * the default path is wrong (e.g. remote host, custom install, or state DB copied from host).
 *
 * Environment variables:
 * - CURSOR_STATE_DB_PATH: full path to state.vscdb (overrides platform default)
 * - CURSOR_USER_DATA_DIR: Cursor "User" data directory; state.vscdb is User/globalStorage/state.vscdb
 * - XDG_CONFIG_HOME: on Linux, used if set (default otherwise ~/.config)
 */

import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export type CursorPlatform = 'darwin' | 'linux' | 'win32';

const RELATIVE_STATE_DB = join('User', 'globalStorage', 'state.vscdb');

/**
 * Default Cursor "User" data directory for the given platform (no env overrides).
 * Matches VS Code / Cursor conventions.
 */
export function getCursorUserDataDir(plat: CursorPlatform = platform() as CursorPlatform): string {
  const home = homedir();
  switch (plat) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Cursor', 'User');
    case 'linux': {
      const configHome = process.env.XDG_CONFIG_HOME || join(home, '.config');
      return join(configHome, 'Cursor', 'User');
    }
    case 'win32': {
      const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
      return join(appData, 'Cursor', 'User');
    }
    default:
      return join(home, '.config', 'Cursor', 'User');
  }
}

/**
 * Resolve the path to Cursor's state.vscdb used for auth (cursorAuth/* keys).
 *
 * Priority:
 * 1. CURSOR_STATE_DB_PATH if set (exact file path)
 * 2. CURSOR_USER_DATA_DIR + /globalStorage/state.vscdb if set
 * 3. Platform default (getCursorUserDataDir(platform) + globalStorage/state.vscdb)
 *
 * @param plat - Override platform (default: process.platform)
 * @returns Absolute path to state.vscdb, or null if directory resolution fails
 */
export function getCursorStateDbPath(plat?: CursorPlatform): string | null {
  const effectivePlatform = (plat ?? platform()) as CursorPlatform;

  if (process.env.CURSOR_STATE_DB_PATH) {
    return process.env.CURSOR_STATE_DB_PATH;
  }

  if (process.env.CURSOR_USER_DATA_DIR) {
    return join(process.env.CURSOR_USER_DATA_DIR, 'globalStorage', 'state.vscdb');
  }

  const userDir = getCursorUserDataDir(effectivePlatform);
  return join(userDir, 'globalStorage', 'state.vscdb');
}

/**
 * Check whether the state.vscdb file exists at the resolved path.
 * Use this before attempting to read (e.g. Cursor not installed or not logged in).
 */
export function cursorStateDbExists(plat?: CursorPlatform): boolean {
  const path = getCursorStateDbPath(plat);
  return path !== null && existsSync(path);
}
