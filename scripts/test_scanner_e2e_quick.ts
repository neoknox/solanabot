import { loadConfig } from '../src/config/index.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { PoolRegistry } from '../src/scanner/poolRegistry.js';
import { loadDiscoveredCandidates } from '../src/scanner/poolDiscovery.js';

async function main() {
  const config = loadConfig({
    MAX_WS_SUBSCRIPTIONS: '25',
    JUPITER_API_URL: 'https://api.jup.ag/swap/v1'
  });

  const discPath = 'C:/Users/HP/solanabot/data/discovered_pools.json';
  const scanner = new ArbitrageScanner(config);
  // Pre-load candidate pools into scanner's pool registry
  scanner.getPoolRegistry().loadDiscoveredCandidates(loadDiscoveredCandidates(discPath));
  console.log('Starting ArbitrageScanner...');
  await scanner.start();

  console.log('ArbitrageScanner started. Monitoring for 15 seconds...');
  for (let i = 1; i <= 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const hud = scanner.getHudV2Data();
    console.log(`[${i}s] WS: ${hud.wsStatus} | Verified Pools: ${hud.routeHealth.verifiedDirectPools}/${hud.routeHealth.totalStoredUniquePools} | READY Routes: ${hud.routeHealth.readyRoutes} | Evals: ${hud.performance.totalEvaluationsSession} | QuoteValid: ${hud.performance.quoteValidEvaluations} (${hud.performance.quoteValidPercentage}%) | EventLoop: ${hud.diagnostics.eventLoopDelayMs}ms`);
  }

  const hud = scanner.getHudV2Data();
  console.log('\n--- Final Telemetry ---');
  console.log('Route Health:', hud.routeHealth);
  console.log('Performance:', hud.performance);
  console.log('Rejection Analysis:', hud.rejectionAnalysis);

  scanner.stop();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
