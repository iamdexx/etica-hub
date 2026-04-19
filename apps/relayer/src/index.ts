import { runCoordinator } from './coordinator';
import { runSigner } from './signer';

/**
 * Relayer entry point. Mode is selected via `$RELAYER_MODE`:
 *   - "coordinator" — run the signature-aggregation HTTP server.
 *   - "signer"      — run a per-validator event watcher + signer.
 *   - "status"      — default; print config hints and exit.
 */

const MODE = (process.env.RELAYER_MODE ?? 'status') as
  | 'coordinator'
  | 'signer'
  | 'status';

async function main(): Promise<void> {
  if (MODE === 'coordinator') {
    runCoordinator();
    return;
  }
  if (MODE === 'signer') {
    await runSigner();
    return;
  }
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'relayer.status',
      msg: 'no mode selected; set RELAYER_MODE=coordinator or RELAYER_MODE=signer',
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
