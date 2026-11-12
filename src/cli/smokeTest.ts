import { config } from '../config/index.js';
import { ArbitrageScanner } from '../scanner/arbitrageScanner.js';

async function main() {
  console.log('================================================================');
  console.log('  SOLANA ARBITRAGE BOT - LIVE MAINNET SMOKE TEST (PHASE 1.2)    ');
  console.log('  COMPETITIVE OPPORTUNITY INTELLIGENCE & 3-LEG CYCLES          ');
  console.log('  (Strictly Read-Only: No Private Keys, No Execution, No Funds) ');
  console.log('================================================================');
  console.log(`Connecting to Solana RPC: ${config.SOLANA_RPC_HTTP}`);
  console.log(`Connecting to Solana WS:  ${config.SOLANA_RPC_WS}`);
  console.log(`WebSocket Commitment:     ${config.WS_COMMITMENT || 'processed'}\n`);

  const cpuStart = process.cpuUsage();
  const startTimeMs = performance.now();

  const scanner = new ArbitrageScanner(config);
  const routeIndex = scanner.getRouteIndex();

  console.log(`Route Index Configured:`);
  console.log(`  Total Directed Routes:     ${routeIndex.getRouteCount()}`);
  console.log(`  - Verified Direct Routes:  ${routeIndex.getVerifiedDirectRouteCount()}`);
  console.log(`  - Blocked Routes (Data):   ${routeIndex.getBlockedRouteCount()}`);
  console.log(`  2-Leg Cycles:              ${routeIndex.getTwoLegRouteCount()}`);
  console.log(`  3-Leg Cycles:              ${routeIndex.getThreeLegRouteCount()}`);
  console.log(`  Intra-DEX Routes:          ${routeIndex.getIntraDexRouteCount()}`);
  console.log(`  Inter-DEX Routes:          ${routeIndex.getInterDexRouteCount()}\n`);

  let indicativeCount = 0;
  let shadowQualifiedCount = 0;
  let invalidCount = 0;

  scanner.onCandidate((c) => {
    const time = new Date(c.timestamp).toISOString();
    const inputUSD = (Number(c.inputAmountUSDC) / 1e6).toFixed(2);
    const outUSD = (Number(c.leg3ExpectedOutUSDC || c.leg2ExpectedOutUSDC) / 1e6).toFixed(2);
    
    if (c.qualityLabel === 'SHADOW_QUALIFIED') shadowQualifiedCount++;
    else if (c.qualityLabel === 'INDICATIVE_ONLY') indicativeCount++;
    else invalidCount++;

    if (c.status === 'QUALIFIED_SHADOW' || c.status === 'CANDIDATE') {
      console.log(`[CANDIDATE ${c.status} | ${c.qualityLabel}] ${time} ${c.routeName}`);
      console.log(`  Cycle: ${c.cycleType || '2_LEG'} | Optimal Size: $${inputUSD} -> Final Out: $${outUSD}`);
      console.log(`  Expected Net: $${c.expectedNetUSDC} | Conservative Net: $${c.minConservativeNetUSDC}`);
      console.log(`  Consumed Cost: $${c.consumedCostUSDC} | Potential Loss On Failure: $${c.potentialLossOnFailureUSDC}`);
      if (c.rejectionReasons.length > 0) {
        console.log(`  Rejection Reasons: ${c.rejectionReasons.join(', ')}`);
      }
      console.log('');
    }
  });

  await scanner.start();

  const scanDurationSec = process.env.SCAN_DURATION_SEC ? parseInt(process.env.SCAN_DURATION_SEC, 10) : 60;
  console.log(`Running sustained read-only scan against Solana mainnet for ${scanDurationSec} seconds...\n`);
  await new Promise(resolve => setTimeout(resolve, scanDurationSec * 1000));

  const totalRunTimeMs = performance.now() - startTimeMs;
  const cpuEnd = process.cpuUsage(cpuStart);
  const memUsage = process.memoryUsage();

  const health = scanner.getHealthStatus();
  const audit = scanner.getAuditMetrics();
  const latency = scanner.getLatencyReport();
  const queueStats = scanner.getEventQueueStats();

  scanner.getRepository().recordAuditMetrics(audit);

  console.log('================================================================');
  console.log('  MAINNET SMOKE TEST & COMPETITIVE BENCHMARK COMPLETED          ');
  console.log('================================================================');
  console.log(`Final Solana Slot:              ${health.currentSlot}`);
  console.log(`WebSocket Feed Status:          ${health.connectedWs ? 'CONNECTED' : 'DISCONNECTED'}`);
  console.log(`Active Monitored Pools:         ${health.activePoolCount}`);
  console.log(`Configured Routes in Index:     ${routeIndex.getRouteCount()}`);
  console.log(`  - Verified Runtime Routes:    ${routeIndex.getVerifiedDirectRouteCount()}`);
  console.log(`  - Blocked Routes (Data/Gate): ${routeIndex.getBlockedRouteCount()}`);
  console.log(`Total Routes Evaluated:         ${audit.totalEvaluated}`);
  console.log(`  - 2-Leg Cycles Evaluated:     ${audit.twoLegEvaluated || 0}`);
  console.log(`  - 3-Leg Cycles Evaluated:     ${audit.threeLegEvaluated || 0}`);
  console.log(`  - Intra-DEX Evaluated:        ${audit.intraDexEvaluated || 0}`);
  console.log(`  - Inter-DEX Evaluated:        ${audit.interDexEvaluated || 0}`);
  console.log(`Unique Opportunities:           ${audit.uniqueOpportunities}`);
  console.log(`Gross-Positive Candidates:      ${audit.candidatesGrossPositive}`);
  console.log(`Conservative Net Qualified:     ${audit.candidatesConservativeQualified}`);

  console.log('\n--- PROFIT-FIRST OPPORTUNITY FUNNEL METRICS ---');
  console.log(`  Catalog Configured Routes (Static):    ${audit.configuredRouteCount || routeIndex.getRouteCount()}`);
  console.log(`  1. Total Pipeline Evaluation Attempts: ${audit.totalEvaluated}`);
  console.log(`  2. State-Ready Attempts (Hydrated):    ${audit.stateReadyRouteCount || 0}`);
  console.log(`  3. Quote-Valid Attempts (Math Exec):   ${audit.quoteValidRouteCount || 0}`);
  console.log(`  4. Profit-Qualified Attempts (>= $0.50): ${audit.profitQualifiedRouteCount || 0}`);
  console.log(`  5. Execution-Unverified (Phase 1.2):   ${audit.executionUnverifiedRouteCount || 0}`);
  console.log(`  Simulated Capital Limit:               $${config.VIRTUAL_CAPITAL_USDC} USDC`);
  console.log(`  Active Allocated Simulated Capital:    $${scanner.getOpportunityTracker().getActiveAllocatedCapital()} USDC`);
  console.log(`  Execution Guard Status:                SPECIFICATION_ONLY (Not implemented, zero capital protected)`);

  console.log(`Opportunity Quality Labels:`);
  console.log(`  - SHADOW_QUALIFIED:           ${audit.candidatesConservativeQualified}`);
  console.log(`  - INDICATIVE_ONLY:            ${audit.unsupportedRoutes + audit.quoteValidationFailures}`);
  console.log(`  - INVALID / REJECTED:         ${audit.rejectedRoutes}`);
  console.log(`Rejection Reasons Breakdown:    ${JSON.stringify(health.rejectionBreakdown, null, 2)}`);

  console.log('\n--- RUNTIME POOL VERIFICATION STATUS ---');
  const poolReg = scanner.getPoolRegistry();
  for (const pool of poolReg.getAllPools()) {
    console.log(`  [${pool.verificationStatus || 'QUOTE_UNVERIFIED'}] ${pool.dex} (${pool.id}) ${pool.blockerReason ? `| Blocker: ${pool.blockerReason}` : '| RUNTIME_VERIFIED'}`);
  }

  console.log('\n--- CONTINUOUS OPPORTUNITY LIFECYCLE STATS ---');
  const lifecycle = scanner.getOpportunityTracker().getLifecycleStats();
  console.log(`Total Tracked Opportunities:    ${lifecycle.totalTrackedOpportunities}`);
  console.log(`Active Opportunities:           ${lifecycle.activeOpportunitiesCount}`);
  console.log(`Mean Visibility Duration:       ${lifecycle.meanVisibilityDurationMs} ms`);
  console.log(`Max Visibility Duration:        ${lifecycle.maxVisibilityDurationMs} ms`);
  console.log(`p50 Visibility Duration:        ${lifecycle.p50DurationMs} ms`);
  console.log(`p95 Visibility Duration:        ${lifecycle.p95DurationMs} ms`);

  console.log('\n--- ORCA & RAYDIUM STATE INTEGRITY DIAGNOSTICS ---');
  console.log(`  Orca Proven Tick Boundary Exceeded Attempts: ${audit.orcaTickBoundaryAttempts || 0}`);
  console.log(`  Orca Other Quote Failures (Data/Liquidity):   ${audit.orcaOtherFailureAttempts || 0}`);
  console.log(`  Raydium Reconfirmation Attempts:             ${audit.raydiumReconfirmationAttempts || 0}`);
  console.log(`  Raydium Reconfirmation Successes:            ${audit.raydiumReconfirmationSuccesses || 0}`);

  console.log('\n--- COMPETITOR ACTIVITY & CONTENTION INTELLIGENCE ---');
  const monitoredPools = [
    { name: 'Orca Whirlpool (WSOL/USDC 4bps)', id: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE' },
    { name: 'Orca Whirlpool (WSOL/USDC 2bps)', id: 'FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q' },
    { name: 'Raydium AMM V4 (WSOL/USDC)', id: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2' },
    { name: 'Orca Whirlpool (USDC/USDT 1bps)', id: '4fuUiYxTQ6QCrdSq9ouBYcTM7bqSwYTSyLueGZLTy4T4' },
    { name: 'Raydium AMM V4 (WSOL/USDT)', id: '7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX' }
  ];
  for (const p of monitoredPools) {
    const m = scanner.getCompetitorAnalyzer().getCachedMetrics(p.id);
    console.log(`  Pool: ${p.name}`);
    if (m.totalObservedTx === 0) {
      console.log(`    Contention: UNKNOWN (0 tx samples observed) | Historical Competition Score: UNCALIBRATED`);
      console.log(`    Tx Analyzed: 0 | Arb Freq: UNKNOWN`);
      console.log(`    Fee p50: UNKNOWN | Priority Fee p50: UNKNOWN`);
    } else {
      console.log(`    Contention: ${m.contentionLevel} | Historical Competition Score: ${m.historicalCompetitionScore}/100`);
      console.log(`    Tx Analyzed: ${m.totalObservedTx} (Failed: ${m.failedTxCount}) | Est. Arb Freq: ${m.arbitrageLoopFrequencyPerHour}/hr`);
      console.log(`    Fee p50: ${m.feeDistributionLamports.p50} lamports | Priority Fee p50: ${m.priorityFeeStatsMicroLamports.p50} μL`);
    }
  }

  console.log('\n--- LATENCY INSTRUMENTATION BENCHMARKS ---');
  const fmtUs = (stats: typeof latency.detectionToDecisionUs) =>
    `p50: ${(stats.p50).toFixed(1)}μs | p95: ${(stats.p95).toFixed(1)}μs | p99: ${(stats.p99).toFixed(1)}μs | max: ${(stats.max).toFixed(1)}μs | mean: ${(stats.mean).toFixed(1)}μs (n=${stats.count})`;
  
  console.log(`Detection-to-Decision Latency:  ${fmtUs(latency.detectionToDecisionUs)}`);
  console.log(`Quote Calculation Latency:      ${fmtUs(latency.quoteLatencyUs)}`);
  console.log(`Pool State Decoding Latency:    ${fmtUs(latency.decodeLatencyUs)}`);
  console.log(`Profit Validation Latency:      ${fmtUs(latency.validationLatencyUs)}`);
  console.log(`RPC Batch Fetch Latency:        p50: ${latency.rpcLatencyMs.p50.toFixed(1)}ms | p95: ${latency.rpcLatencyMs.p95.toFixed(1)}ms | max: ${latency.rpcLatencyMs.max.toFixed(1)}ms`);
  console.log(`Observed Slot Lag:              ${latency.lastSlotLag} slots`);
  console.log(`Event Loop Delay:               ${latency.eventLoopDelayMs.toFixed(2)} ms`);

  console.log('\n--- EVENT QUEUE & COALESCING STATS ---');
  console.log(`Processed Account Updates:      ${queueStats.processedCount}`);
  console.log(`Coalesced Superseded Updates:   ${queueStats.coalescedCount}`);
  console.log(`Backpressure Dropped Updates:   ${queueStats.droppedCount}`);
  console.log(`Peak Queue Size:                ${queueStats.peakQueueSize}`);

  console.log('\n--- RESOURCE UTILIZATION ---');
  const userCpuSec = (cpuEnd.user / 1e6).toFixed(2);
  const sysCpuSec = (cpuEnd.system / 1e6).toFixed(2);
  const totalCpuSec = ((cpuEnd.user + cpuEnd.system) / 1e6).toFixed(2);
  const cpuPercent = (((cpuEnd.user + cpuEnd.system) / 1e3) / totalRunTimeMs * 100).toFixed(1);
  const rssMb = (memUsage.rss / 1024 / 1024).toFixed(1);
  const heapUsedMb = (memUsage.heapUsed / 1024 / 1024).toFixed(1);
  console.log(`CPU Time Consumed:              ${totalCpuSec}s (User: ${userCpuSec}s, Sys: ${sysCpuSec}s, Avg CPU: ${cpuPercent}%)`);
  console.log(`Memory RSS:                     ${rssMb} MB (Heap Used: ${heapUsedMb} MB)`);
  console.log('================================================================\n');

  scanner.stop();
  process.exit(0);
}

main().catch(err => {
  console.error('Smoke test error:', err);
  process.exit(1);
});
