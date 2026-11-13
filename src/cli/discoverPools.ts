import { config } from '../config/index.js';
import { PoolRegistry } from '../scanner/poolRegistry.js';
import { SolanaRpcProvider } from '../providers/solanaRpc.js';
import { OrcaPoolDiscovery } from '../scanner/poolDiscovery.js';

async function main() {
  console.log('================================================================');
  console.log('  SOLANA ARBITRAGE BOT - BOUNDED ORCA POOL DISCOVERY (PHASE 1.3)');
  console.log('  (Strictly Read-Only, Bounded Pagination, Targeted RPC Reads)  ');
  console.log('================================================================');

  const poolRegistry = new PoolRegistry();
  const initialPools = poolRegistry.getAllPools();
  console.log(`Initial Catalog Pools in Registry: ${initialPools.length}`);
  console.log('Existing Verified Orca Pools:');
  for (const p of initialPools.filter(p => p.dex === 'ORCA_WHIRLPOOL')) {
    console.log(`  - [${p.verificationStatus}] ${p.id} (${p.description})`);
  }

  const rpcProvider = new SolanaRpcProvider(config);
  const discovery = new OrcaPoolDiscovery({
    pageSize: 10,
    maxPages: 3,
    timeoutMs: 10000,
    maxRetries: 1
  });

  console.log('\nRunning bounded discovery against Orca public API (max 3 pages, limit 10)...');
  const report = await discovery.runDiscoveryAndVerification(poolRegistry, rpcProvider);

  console.log('\n================================================================');
  console.log('  ORCA POOL DISCOVERY & ON-CHAIN VERIFICATION REPORT             ');
  console.log('================================================================');
  console.log(`Discovery API Status:       ${report.apiStatus}`);
  console.log(`Pages Fetched:              ${report.pagesFetched}`);
  console.log(`Candidates Discovered:      ${report.candidatesFound}`);
  console.log(`Candidates Verified On-Chain:${report.candidatesVerified}`);
  console.log(`Candidates Rejected:        ${report.candidatesRejected}`);
  console.log(`Discovery Duration:         ${report.durationMs}ms`);

  if (report.errors.length > 0) {
    console.log(`Errors / Blockers:          ${report.errors.join(', ')}`);
  }

  console.log('\nDetailed Candidate Verification Results:');
  if (report.results.length === 0) {
    console.log('  (No new external candidates processed; existing registry intact)');
  } else {
    for (const res of report.results) {
      console.log(`  Pool: ${res.address}`);
      console.log(`    Verified:        ${res.verified}`);
      if (res.verified) {
        console.log(`    Status:          ${res.poolConfig?.verificationStatus}`);
        console.log(`    Owner:           ${res.onChainOwner}`);
        console.log(`    Data Length:     ${res.dataLength} bytes`);
        console.log(`    Active Liquidity:${res.activeLiquidity}`);
      } else {
        console.log(`    Rejection Reason:${res.blockerReason}`);
      }
    }
  }

  const finalPools = poolRegistry.getAllPools();
  console.log(`\nFinal Pools in Registry:    ${finalPools.length}`);
  console.log('Registry Status Summary:');
  console.log(`  - Verified Direct:         ${finalPools.filter(p => p.verificationStatus === 'VERIFIED_DIRECT').length}`);
  console.log(`  - Quote Unverified:        ${finalPools.filter(p => p.verificationStatus === 'QUOTE_UNVERIFIED').length}`);
  console.log('================================================================\n');
}

main().catch(err => {
  console.error('[FATAL] Discovery error:', err);
  process.exit(1);
});
