import { mkdir, writeFile } from 'node:fs/promises';
import { BASELINES_DIR, baselinePath } from './baselines.ts';
import { encodePng } from './png.ts';
import { renderScene, SCENES, syntheticSource } from './scenes.ts';

/** Regenerates every baseline PNG: `bun run --filter @demoflow/renderer test:update-baselines`. */
const source = syntheticSource();
await mkdir(BASELINES_DIR, { recursive: true });
for (const scene of SCENES) {
  await writeFile(
    baselinePath(scene.name),
    encodePng(renderScene(scene, source)),
  );
  console.info(`wrote ${baselinePath(scene.name)}`);
}
