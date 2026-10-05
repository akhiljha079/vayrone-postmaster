// Entry point of the vpm executable (bundled to app/vpm.mjs by scripts/build-release.mjs).
import { main } from './vpm.js';

main(process.argv.slice(2)).catch((err) => {
  console.error('vpm:', (err as Error).message ?? err);
  process.exit(1);
});
