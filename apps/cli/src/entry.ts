import { fileURLToPath } from 'node:url';

/**
 * The CLI's own entry point: `main.js` beside this module. True of the tsc
 * build (`dist/entry.js` → `dist/main.js`) and of the published bundle, where
 * every module shares the bundle's URL (`dist/bin/main.js`).
 */
export const CLI_ENTRY = fileURLToPath(new URL('./main.js', import.meta.url));
