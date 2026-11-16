import { ArbitrageScanner } from '../src/scanner/arbitrageScanner';
import { loadConfig } from '../src/config';

async function main() {
  const config = loadConfig();
  const scanner = new ArbitrageScanner(config);
  console.log(`Starting refreshAllPoolStates...`);
  await scanner.refreshAllPoolStates();

  const routeIndex = scanner.getRouteIndex();
  console.log('\nRoute Counts after refreshAllPoolStates:');
  console.log(`Total Routes:      ${routeIndex.getRouteCount()}`);
  console.log(`VERIFIED Routes:   ${routeIndex.getRouteCountByState('VERIFIED')}`);
  console.log(`READY Routes:      ${routeIndex.getRouteCountByState('READY')}`);
  console.log(`STALE Routes:      ${routeIndex.getRouteCountByState('STALE')}`);
  console.log(`BLOCKED Routes:    ${routeIndex.getRouteCountByState('BLOCKED')}`);
  console.log(`UNVALIDATED:       ${routeIndex.getRouteCountByState('UNVALIDATED')}`);

  scanner.stop();
}

main().catch(console.error);
