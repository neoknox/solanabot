import { loadConfig } from '../src/config/index.js';
import { PoolRegistry } from '../src/scanner/poolRegistry.js';
import { loadDiscoveredCandidates } from '../src/scanner/poolDiscovery.js';
import { SolanaRpcProvider } from '../src/providers/solanaRpc.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { ArbitrageRepository } from '../src/storage/repository.js';
import { ProfitThresholdManager } from '../src/profit/profitThresholdManager.js';

async function main() {
  const config = loadConfig();
  const repo = new ArbitrageRepository(config);
  const thresh = new ProfitThresholdManager();
  const scanner = new ArbitrageScanner(config, undefined, undefined, undefined, repo, thresh);

  console.log('Testing refreshAllPoolStates on live scanner...');
  const poolReg = scanner.getPoolRegistry();
  const poolsBefore = poolReg.getAllPools();
  console.log(`Pools in scanner: ${poolsBefore.length}`);
  const verifiedBefore = poolsBefore.filter(p => p.verificationStatus === 'VERIFIED_DIRECT').length;
  console.log(`Verified before: ${verifiedBefore} / ${poolsBefore.length}`);

  try {
    await scanner.refreshAllPoolStates();
  } catch (err) {
    console.error('refreshAllPoolStates threw error:', err);
  }

  const poolsAfter = poolReg.getAllPools();
  const verifiedAfter = poolsAfter.filter(p => p.verificationStatus === 'VERIFIED_DIRECT').length;
  console.log(`Verified after: ${verifiedAfter} / ${poolsAfter.length}`);

  const blockers: Record<string, number> = {};
  for (const p of poolsAfter) {
    if (p.verificationStatus !== 'VERIFIED_DIRECT') {
      const b = p.blockerReason || 'UNKNOWN';
      blockers[b] = (blockers[b] || 0) + 1;
    }
  }
  console.log('Blockers after refresh:', blockers);

  for (const p of poolsAfter) {
    if (p.verificationStatus !== 'VERIFIED_DIRECT') {
      console.log(`  Unverified: ${p.id} [${p.dex}] -> ${p.blockerReason}`);
    } else {
      console.log(`  VERIFIED:   ${p.id} [${p.dex}]`);
    }
  }

  repo.close();
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
