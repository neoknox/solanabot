import { ArbitrageScanner } from '../src/scanner/arbitrageScanner';
import { loadConfig } from '../src/config';

async function main() {
  const config = loadConfig();
  const scanner = new ArbitrageScanner(config);
  const pools = scanner.getPoolRegistry().getAllPools();
  console.log(`Scanner pools total: ${pools.length}`);
  
  const verified = pools.filter(p => p.verificationStatus === 'VERIFIED_DIRECT');
  console.log(`Scanner verified pools at construction: ${verified.length}`);
  for (const p of verified) {
    console.log(`  - ${p.id.slice(0, 10)}... ${p.dex} (${p.description || ''})`);
  }

  const unverified = pools.filter(p => p.verificationStatus !== 'VERIFIED_DIRECT');
  console.log(`Scanner unverified pools: ${unverified.length}`);
  const blockerCounts: Record<string, number> = {};
  for (const p of unverified) {
    const reason = p.blockerReason || 'UNKNOWN';
    blockerCounts[reason] = (blockerCounts[reason] || 0) + 1;
  }
  for (const [k, v] of Object.entries(blockerCounts)) {
    console.log(`  ${k.padEnd(35)}: ${v}`);
  }

  scanner.stop();
}

main().catch(console.error);
