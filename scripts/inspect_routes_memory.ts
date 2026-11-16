import { loadConfig } from '../src/config/index.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { ArbitrageRepository } from '../src/storage/repository.js';
import { ProfitThresholdManager } from '../src/profit/profitThresholdManager.js';

async function main() {
  const config = loadConfig({ DB_PATH: 'C:/Users/HP/solanabot/data/arbitrage_scanner.db' });
  const repo = new ArbitrageRepository(config);
  const thresh = new ProfitThresholdManager();
  const scanner = new ArbitrageScanner(config, undefined, undefined, undefined, repo, thresh);

  const routeIdx = (scanner as any).routeIndex;
  const allRoutes = routeIdx.getAllRoutes();
  console.log(`Total routes in RouteIndex in memory: ${allRoutes.length}`);
  const byState: Record<string, number> = {};
  for (const r of allRoutes) {
    byState[r.state] = (byState[r.state] || 0) + 1;
  }
  console.log('Route states in memory:', byState);

  const hud = scanner.getHudV2Data();
  console.log('HUD routeHealth:', hud.routeHealth);

  repo.close();
}

main().catch(console.error);
