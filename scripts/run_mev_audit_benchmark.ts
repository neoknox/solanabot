import fs from 'fs';
import path from 'path';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { loadConfig, maskEndpoint } from '../src/config/index.js';
import { CompetitorResearchAuditor } from '../src/competition/competitorResearch.js';

interface BoundedBenchmarkReport {
  timestamp: string;
  durationSeconds: number;
  connectionHealth: {
    wsConnected: boolean;
    uptimePercent: number;
    downtimeEventsCount: number;
    totalDowntimeMs: number;
    slotGapCount: number;
    totalSlotsSkipped: number;
    maxSlotGap: number;
    confirmedSubscriptionCount: number;
    activeAccountsWithUpdates: number;
    messagesTotal: number;
  };
  rpcMetrics: {
    requestsTotal: number;
    requestsFailed: number;
    latencyP50Ms: number;
    latencyP95Ms: number;
    latencyP99Ms: number;
  };
  quoteMetrics: {
    totalEvaluated: number;
    quoteValidEvaluations: number;
    quoteValidRatePercent: number;
    averageReadyRoutes: number;
    peakReadyRoutes: number;
    quoteLatencyP50Us: number;
    quoteLatencyP95Us: number;
    quoteLatencyP99Us: number;
  };
  profitFunnel: {
    grossPositive: number;
    positiveAfterModeledFees: number;
    positiveAfterSafetyBuffer: number;
    qualifiedAboveTarget10c: number;
    independentlyRevalidated: number;
  };
  revalidationEvidence: {
    totalSamples: number;
    sameCachedSnapshotCount: number;
    independentObservationCount: number;
    marketStateChangedCount: number;
    survivedCount: number;
    survivalRatePercent: number;
  };
  systemHealth: {
    rssMb: number;
    heapUsedMb: number;
    cpuUserMs: number;
    cpuSystemMs: number;
  };
  competitorBenchmark: {
    analyzedDocumentedTrades: number;
    avgCompetitorNetUSDC: number;
    coverageGapsIdentified: number;
    identifiedGaps: string[];
  };
}

async function runBoundedBenchmark() {
  console.log('================================================================');
  console.log('  SOLANABOT — MEV RESEARCH AUDIT BOUNDED BENCHMARK (15s RUN)    ');
  console.log('  Strictly Read-Only | Real Mainnet Telemetry | No Live Trading ');
  console.log('================================================================\n');

  // Safety hard-exit watchdog after 35 seconds
  const watchdog = setTimeout(() => {
    console.error('[WATCHDOG] 35-second benchmark ceiling hit. Forcing graceful exit.');
    process.exit(0);
  }, 35000);
  watchdog.unref();

  // Ephemeral database path to avoid locking arbitrage.db (used by active HUD)
  const ephemeralDbPath = path.join(process.cwd(), 'data', `benchmark_audit_${Date.now()}.db`);
  const config = loadConfig({
    DB_PATH: ephemeralDbPath,
    MIN_NET_PROFIT_USDC: '0.10',
    SAFETY_BUFFER_USDC: '0.25',
    SCOUT_INTERVAL_MS: 600000 // Do not run automatic scout during short benchmark
  });

  const cpuStart = process.cpuUsage();
  const startTime = Date.now();
  const DURATION_SECONDS = 10;

  console.log(`[INIT] Connecting to RPC: ${maskEndpoint(config.SOLANA_RPC_HTTP)}`);
  console.log(`[INIT] Connecting to WS:  ${maskEndpoint(config.SOLANA_RPC_WS)}`);

  const scanner = new ArbitrageScanner(config);
  await scanner.start();

  console.log(`[RUN] Scanner active. Measuring telemetry for ${DURATION_SECONDS} seconds...`);

  const routeIndex = scanner.getRouteIndex();
  let healthySeconds = 0;

  for (let s = 1; s <= DURATION_SECONDS; s++) {
    await new Promise(r => setTimeout(r, 1000));
    const isWs = scanner.getWs().getConnectionState() === 'CONNECTED';
    if (isWs) healthySeconds++;
    routeIndex.recordReadySample();

    const readyCount = routeIndex.getReadyRouteCount();
    const verifiedCount = routeIndex.getVerifiedRouteCount();
    const wsStats = scanner.getWs().getStats();
    process.stdout.write(`\r[T+${s.toString().padStart(2, ' ')}s] WS: ${isWs ? 'CONNECTED' : 'DISCONNECTED'} | READY: ${readyCount} | VERIFIED: ${verifiedCount} | WS Msgs: ${wsStats.messagesTotal}`);
  }
  console.log('\n[STOP] Benchmark sampling complete. Gathering final telemetry...');

  const wsStats = scanner.getWs().getStats();
  const rpcStats = scanner.getRpc().getStats();
  const auditMetrics = scanner.getAuditMetrics();
  const latency = scanner.getLatencyReport();
  const readySummary = routeIndex.getReadyMetricsSummary();
  const mem = process.memoryUsage();
  const cpuEnd = process.cpuUsage(cpuStart);

  // Competitor audit comparison
  const poolReg = scanner.getPoolRegistry();
  const registeredPools = new Set(poolReg.getAllPools().map(p => p.id));
  const verifiedPools = new Set(poolReg.getAllPools().filter(p => p.verificationStatus === 'VERIFIED_DIRECT').map(p => p.id));
  const gaps = CompetitorResearchAuditor.identifyCoverageGaps(registeredPools, verifiedPools);
  const competitorSummary = CompetitorResearchAuditor.getBenchmarkSummary();

  const totalEvaluated = auditMetrics.totalEvaluated || 0;
  const quoteValid = auditMetrics.quoteValidRouteCount || 0;
  const quoteValidRate = totalEvaluated > 0 ? (quoteValid / totalEvaluated) * 100 : 0;
  const revalSamples = auditMetrics.revalidationSamplesCount || 0;
  const revalSurvived = auditMetrics.revalidationSurvivedCount || 0;
  const survivalRate = revalSamples > 0 ? (revalSurvived / revalSamples) * 100 : 0;

  const report: BoundedBenchmarkReport = {
    timestamp: new Date().toISOString(),
    durationSeconds: DURATION_SECONDS,
    connectionHealth: {
      wsConnected: scanner.getWs().getConnectionState() === 'CONNECTED',
      uptimePercent: (healthySeconds / DURATION_SECONDS) * 100,
      downtimeEventsCount: wsStats.downtimeEventsCount || 0,
      totalDowntimeMs: wsStats.totalDowntimeMs || 0,
      slotGapCount: wsStats.slotGapCount || 0,
      totalSlotsSkipped: wsStats.totalSlotsSkipped || 0,
      maxSlotGap: wsStats.maxSlotGap || 0,
      confirmedSubscriptionCount: wsStats.confirmedSubscriptionCount || wsStats.subscriptionCount,
      activeAccountsWithUpdates: wsStats.activeAccountsWithUpdates || 0,
      messagesTotal: wsStats.messagesTotal || 0
    },
    rpcMetrics: {
      requestsTotal: rpcStats.requestsTotal,
      requestsFailed: rpcStats.requestsFailed,
      latencyP50Ms: latency.rpcLatencyMs?.p50 || 0,
      latencyP95Ms: latency.rpcLatencyMs?.p95 || 0,
      latencyP99Ms: latency.rpcLatencyMs?.p99 || 0
    },
    quoteMetrics: {
      totalEvaluated,
      quoteValidEvaluations: quoteValid,
      quoteValidRatePercent: Number(quoteValidRate.toFixed(2)),
      averageReadyRoutes: Number(readySummary.timeWeightedReadyAvg.toFixed(2)),
      peakReadyRoutes: readySummary.peakReady,
      quoteLatencyP50Us: latency.quoteLatencyUs?.p50 || 0,
      quoteLatencyP95Us: latency.quoteLatencyUs?.p95 || 0,
      quoteLatencyP99Us: latency.quoteLatencyUs?.p99 || 0
    },
    profitFunnel: {
      grossPositive: auditMetrics.candidatesGrossPositive || 0,
      positiveAfterModeledFees: auditMetrics.candidatesPositiveAfterModeledFees || 0,
      positiveAfterSafetyBuffer: auditMetrics.candidatesPositiveAfterSafetyBuffer || 0,
      qualifiedAboveTarget10c: auditMetrics.candidatesQualifiedAboveTarget || 0,
      independentlyRevalidated: auditMetrics.candidatesIndependentlyRevalidated || 0
    },
    revalidationEvidence: {
      totalSamples: revalSamples,
      sameCachedSnapshotCount: auditMetrics.revalidationSameCachedCount || 0,
      independentObservationCount: auditMetrics.revalidationIndependentCount || 0,
      marketStateChangedCount: auditMetrics.revalidationMarketChangeCount || 0,
      survivedCount: revalSurvived,
      survivalRatePercent: Number(survivalRate.toFixed(2))
    },
    systemHealth: {
      rssMb: Number((mem.rss / 1024 / 1024).toFixed(2)),
      heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
      cpuUserMs: Math.round(cpuEnd.user / 1000),
      cpuSystemMs: Math.round(cpuEnd.system / 1000)
    },
    competitorBenchmark: {
      analyzedDocumentedTrades: competitorSummary.totalAnalyzed,
      avgCompetitorNetUSDC: competitorSummary.avgNetProfitUSDC,
      coverageGapsIdentified: gaps.length,
      identifiedGaps: gaps.map(g => `${g.dex} (${g.poolId}) - Missing in bot catalog`)
    }
  };

  scanner.stop();

  // Clean up ephemeral db
  try {
    if (fs.existsSync(ephemeralDbPath)) {
      fs.unlinkSync(ephemeralDbPath);
    }
    const shm = `${ephemeralDbPath}-shm`;
    const wal = `${ephemeralDbPath}-wal`;
    if (fs.existsSync(shm)) fs.unlinkSync(shm);
    if (fs.existsSync(wal)) fs.unlinkSync(wal);
  } catch {
    // Ignore cleanup error
  }

  const outPath = path.join(process.cwd(), 'benchmark_mev_audit_result.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('\n================================================================');
  console.log('              BENCHMARK TELEMETRY RESULTS                       ');
  console.log('================================================================');
  console.log(`Duration:                    ${report.durationSeconds}s`);
  console.log(`Healthy Monitoring Uptime:   ${report.connectionHealth.uptimePercent.toFixed(1)}%`);
  console.log(`WS Confirmed Subscriptions:  ${report.connectionHealth.confirmedSubscriptionCount}`);
  console.log(`WS Active Account Updates:   ${report.connectionHealth.activeAccountsWithUpdates}`);
  console.log(`WS Slot Gaps Observed:       ${report.connectionHealth.slotGapCount} (Max gap: ${report.connectionHealth.maxSlotGap})`);
  console.log(`WS Downtime Events / Time:   ${report.connectionHealth.downtimeEventsCount} / ${report.connectionHealth.totalDowntimeMs}ms`);
  console.log(`RPC Requests Total / Failed: ${report.rpcMetrics.requestsTotal} / ${report.rpcMetrics.requestsFailed}`);
  console.log(`RPC Latency (p50/p95/p99):   ${report.rpcMetrics.latencyP50Ms}ms / ${report.rpcMetrics.latencyP95Ms}ms / ${report.rpcMetrics.latencyP99Ms}ms`);
  console.log(`Total Routes Evaluated:      ${report.quoteMetrics.totalEvaluated}`);
  console.log(`Quote-Valid Evaluations:     ${report.quoteMetrics.quoteValidEvaluations} (${report.quoteMetrics.quoteValidRatePercent}%)`);
  console.log(`READY Routes (Avg / Peak):   ${report.quoteMetrics.averageReadyRoutes} / ${report.quoteMetrics.peakReadyRoutes}`);
  console.log(`Quote Latency (p50/p95/p99): ${report.quoteMetrics.quoteLatencyP50Us}us / ${report.quoteMetrics.quoteLatencyP95Us}us / ${report.quoteMetrics.quoteLatencyP99Us}us`);
  console.log('----------------------------------------------------------------');
  console.log('                     PROFIT FUNNEL                              ');
  console.log('----------------------------------------------------------------');
  console.log(`1. Gross-Positive:           ${report.profitFunnel.grossPositive}`);
  console.log(`2. Positive After Fees:      ${report.profitFunnel.positiveAfterModeledFees}`);
  console.log(`3. Positive After Buffer:    ${report.profitFunnel.positiveAfterSafetyBuffer}`);
  console.log(`4. Qualified >= $0.10:       ${report.profitFunnel.qualifiedAboveTarget10c}`);
  console.log(`5. Independently Revalidated:${report.profitFunnel.independentlyRevalidated}`);
  console.log('----------------------------------------------------------------');
  console.log('                 REVALIDATION EVIDENCE                          ');
  console.log('----------------------------------------------------------------');
  console.log(`Revalidation Samples:        ${report.revalidationEvidence.totalSamples}`);
  console.log(`- Same Cached Snapshot:      ${report.revalidationEvidence.sameCachedSnapshotCount}`);
  console.log(`- Independent Observation:   ${report.revalidationEvidence.independentObservationCount}`);
  console.log(`- Market State Changed:      ${report.revalidationEvidence.marketStateChangedCount}`);
  console.log(`Survived Revalidations:      ${report.revalidationEvidence.survivedCount}`);
  console.log('----------------------------------------------------------------');
  console.log('                     SYSTEM HEALTH                              ');
  console.log('----------------------------------------------------------------');
  console.log(`Process RSS / Heap Used:     ${report.systemHealth.rssMb} MB / ${report.systemHealth.heapUsedMb} MB`);
  console.log(`CPU User / System Time:      ${report.systemHealth.cpuUserMs}ms / ${report.systemHealth.cpuSystemMs}ms`);
  console.log('----------------------------------------------------------------');
  console.log('                COMPETITOR GAPS IDENTIFIED                      ');
  console.log('----------------------------------------------------------------');
  console.log(`Competitor Coverage Gaps:    ${report.competitorBenchmark.coverageGapsIdentified}`);
  for (const gap of report.competitorBenchmark.identifiedGaps) {
    console.log(`  * ${gap}`);
  }
  console.log('================================================================');
  console.log(`Telemetry saved to: ${outPath}\n`);

  process.exit(0);
}

runBoundedBenchmark().catch(err => {
  console.error('[FATAL] Benchmark failed:', err);
  process.exit(1);
});
