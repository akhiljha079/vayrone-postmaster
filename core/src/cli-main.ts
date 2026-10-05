// Development entry for `npm run cli -w core`. Installed servers use `vpm cli …`.
import { runCli } from './cli.js';

runCli(process.argv.slice(2)).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
