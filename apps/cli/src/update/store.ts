import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { globalConfigPath } from '../config/home.ts';
import { type HostEnvironment, pathFor } from '../config/platform.ts';

/** Where "never for this version" is kept (spec 166, Decision 6). */
export interface SkipStore {
  read(): string | undefined;
  write(version: string): void;
}

/** `update.json` beside the global `config.json`. */
export function updateStorePath(host: HostEnvironment): string {
  const p = pathFor(host.platform);
  return p.join(p.dirname(globalConfigPath(host)), 'update.json');
}

/** A store that never fails: an unreadable file is no skip, an unwritable one is ignored. */
export function fileSkipStore(host: HostEnvironment): SkipStore {
  const file = updateStorePath(host);
  return {
    read() {
      try {
        const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof raw !== 'object' || raw === null) return undefined;
        const { skipVersion } = raw as { skipVersion?: unknown };
        return typeof skipVersion === 'string' ? skipVersion : undefined;
      } catch {
        return undefined;
      }
    },
    write(version) {
      try {
        mkdirSync(pathFor(host.platform).dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify({ skipVersion: version })}\n`);
      } catch {
        // The prompt still works; it asks again next run.
      }
    },
  };
}
