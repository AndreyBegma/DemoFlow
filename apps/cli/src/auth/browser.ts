import { spawn } from 'node:child_process';

/** Opens a URL in the user's browser. Never throws: a missing opener is not an error. */
export type OpenUrl = (url: string) => void;

export function openerCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  // `start` is a cmd builtin and treats its first quoted argument as a window title.
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '""', url] };
  }
  return { command: 'xdg-open', args: [url] };
}

export const openUrl: OpenUrl = (url) => {
  try {
    const { command, args } = openerCommand(process.platform, url);
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      windowsVerbatimArguments: process.platform === 'win32',
    });
    // ENOENT arrives as an event, not a throw.
    child.on('error', () => {});
    child.unref();
  } catch {
    // No browser: the URL is printed anyway.
  }
};
