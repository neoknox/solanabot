import { ArbitrageScanner } from '../src/scanner/arbitrageScanner';
import { loadConfig } from '../src/config';

async function main() {
  const config = loadConfig();
  const scanner = new ArbitrageScanner(config);
  console.log(`Starting refreshAllPoolStates...`);
  await scanner.refreshAllPoolStates();

  const pools = scanner.getPoolRegistry().getAllPools();
  const verified = pools.filter(p => p.verificationStatus === 'VERIFIED_DIRECT');
  const unverified = pools.filter(p => p.verificationStatus !== 'VERIFIED_DIRECT');

  console.log(`\nResults after refreshAllPoolStates:`);
  console.log(`Total pools:      ${pools.length}`);
  console.log(`Verified pools:   ${verified.length}`);
  console.log(`Unverified pools: ${unverified.length}`);

  console.log('\nVerified pools:');
  for (const p of verified) {
    console.log(`  [VERIFIED] ${p.id.slice(0, 12)}... ${p.dex} (${p.description || ''})`);
  }

  const blockerCounts: Record<string, number> = {};
  for (const p of unverified) {
    const reason = p.blockerReason || 'UNKNOWN';
    blockerCounts[reason] = (blockerCounts[reason] || 0) + 1;
  }
  console.log('\nUnverified blocker breakdown:');
  for (const [k, v] of Object.entries(blockerCounts)) {
    console.log(`  ${k.padEnd(35)}: ${v}`);
  }

  scanner.stop();
}

main().catch(console.error);
