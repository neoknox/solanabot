import { loadConfig, maskEndpoint } from '../src/config/index.js';
import { ArbitrageScanner } from '../src/scanner/arbitrageScanner.js';
import { ProfitThresholdManager } from '../src/profit/profitThresholdManager.js';

async function diagnoseStartup() {
  console.log('================================================================');
  console.log('SOLANABOT — STARTUP READINESS & INITIALIZATION DIAGNOSTIC');
  console.log('================================================================\n');

  const config = loadConfig();
  console.log(`[CONFIG] HTTP Endpoint: ${maskEndpoint(config.SOLANA_RPC_HTTP)}`);
  console.log(`[CONFIG] WS Endpoint:   ${maskEndpoint(config.SOLANA_RPC_WS)}`);
  console.log(`[CONFIG] WS Cap:        ${config.MAX_WS_SUBSCRIPTIONS}\n`);

  const thresholdManager = new ProfitThresholdManager({ silent: true });
  const scanner = new ArbitrageScanner(
    config,
    undefined,
    undefined,
    undefined,
    undefined,
    thresholdManager
  );

  const rpc = scanner.getRpc();
  const ws = scanner.getWs();

  const stageTimings: Array<{
    stage: string;
    elapsedMs: number;
    rpcTotal: number;
    rpcFailed: number;
    status: string;
    detail?: string;
  }> = [];

  const tOverallStart = performance.now();

  // STAGE 1: WS Connection
  console.log('[STAGE 1/5] Establishing WebSocket Connection...');
  const t1 = performance.now();
  const rpcBefore1 = rpc.getStats();
  const connected = await ws.connect(8000);
  const elapsed1 = Math.round(performance.now() - t1);
  const rpcAfter1 = rpc.getStats();
  stageTimings.push({
    stage: '1. WebSocket Connection',
    elapsedMs: elapsed1,
    rpcTotal: rpcAfter1.requestsTotal - rpcBefore1.requestsTotal,
    rpcFailed: rpcAfter1.requestsFailed - rpcBefore1.requestsFailed,
    status: connected ? 'SUCCESS' : 'FAILED',
    detail: `Stage: ${ws.getConnectionStage()}, Slot: ${ws.getCurrentSlot()}`
  });
  console.log(`   -> Elapsed: ${elapsed1}ms | Status: ${connected ? 'SUCCESS' : 'FAILED'} (WS Stage: ${ws.getConnectionStage()})`);

  // STAGE 2: SOL Price Refresh
  console.log('\n[STAGE 2/5] Fetching Fresh Live SOL Price...');
  const t2 = performance.now();
  const rpcBefore2 = rpc.getStats();
  await scanner.refreshSolPrice();
  const elapsed2 = Math.round(performance.now() - t2);
  const rpcAfter2 = rpc.getStats();
  const solPrice = scanner.getHudV2Data().solanaSlot; // or check sol price
  stageTimings.push({
    stage: '2. SOL Price Refresh',
    elapsedMs: elapsed2,
    rpcTotal: rpcAfter2.requestsTotal - rpcBefore2.requestsTotal,
    rpcFailed: rpcAfter2.requestsFailed - rpcBefore2.requestsFailed,
    status: 'SUCCESS',
    detail: `SOL Price: $${(scanner as any).currentSolPriceUSDC?.toFixed(2) || 'N/A'}`
  });
  console.log(`   -> Elapsed: ${elapsed2}ms | SOL Price: $${(scanner as any).currentSolPriceUSDC?.toFixed(2) || 'N/A'}`);

  // STAGE 3: RPC Pool Hydration
  console.log('\n[STAGE 3/5] RPC Pool State Snapshot Hydration...');
  const t3 = performance.now();
  const rpcBefore3 = rpc.getStats();
  await scanner.refreshAllPoolStates();
  const elapsed3 = Math.round(performance.now() - t3);
  const rpcAfter3 = rpc.getStats();
  const poolStates = (scanner as any).stateCache.getAllPoolStates();
  stageTimings.push({
    stage: '3. RPC Pool Hydration',
    elapsedMs: elapsed3,
    rpcTotal: rpcAfter3.requestsTotal - rpcBefore3.requestsTotal,
    rpcFailed: rpcAfter3.requestsFailed - rpcBefore3.requestsFailed,
    status: poolStates.length > 0 ? 'SUCCESS' : 'FAILED',
    detail: `Hydrated Pools: ${poolStates.length}`
  });
  console.log(`   -> Elapsed: ${elapsed3}ms | Hydrated Pools: ${poolStates.length} | RPC Requests: ${rpcAfter3.requestsTotal - rpcBefore3.requestsTotal} (${rpcAfter3.requestsFailed - rpcBefore3.requestsFailed} failed)`);

  // STAGE 4: Bundle Subscription Planning & Dispatch
  console.log('\n[STAGE 4/5] Planning Complete Pool Bundles & Dispatching Subscriptions...');
  const t4 = performance.now();
  const rpcBefore4 = rpc.getStats();
  scanner.planAndSubscribeCompletePoolBundles();
  const elapsed4 = Math.round(performance.now() - t4);
  const rpcAfter4 = rpc.getStats();
  const wsStatsAfterPlan = ws.getStats();
  stageTimings.push({
    stage: '4. Bundle Subscription Planning',
    elapsedMs: elapsed4,
    rpcTotal: rpcAfter4.requestsTotal - rpcBefore4.requestsTotal,
    rpcFailed: rpcAfter4.requestsFailed - rpcBefore4.requestsFailed,
    status: 'SUCCESS',
    detail: `Bundles: ${(scanner as any).monitoredPoolBundleCount}, Queued WS Accounts: ${wsStatsAfterPlan.subscriptionCount}`
  });
  console.log(`   -> Elapsed: ${elapsed4}ms | Bundles Monitored: ${(scanner as any).monitoredPoolBundleCount} | Accounts Queued: ${wsStatsAfterPlan.subscriptionCount}`);

  // STAGE 5: Subscription Confirmations & First Account Notifications Wait
  console.log('\n[STAGE 5/5] Waiting for Subscription Confirmations & Live Account Notifications...');
  const t5 = performance.now();
  let firstAccountUpdateReceived = false;
  let firstQuoteReceived = false;
  const timeoutMs = 8000;
  const pollStart = Date.now();

  // Start drain timer & evaluation loop
  (scanner as any).isRunning = true;
  (scanner as any).lastQuoteCountResetTime = Date.now();
  (scanner as any).lastEventLoopTime = performance.now();
  const scanInterval = config.SCAN_INTERVAL_MS || 500;
  const scanTimer = setInterval(async () => {
    await (scanner as any).drainEventQueue();
  }, scanInterval);

  while (Date.now() - pollStart < timeoutMs) {
    const wsStats = ws.getStats();
    const hud = scanner.getHudV2Data();
    if (wsStats.activeAccountUpdatesCount && wsStats.activeAccountUpdatesCount > 0 && !firstAccountUpdateReceived) {
      firstAccountUpdateReceived = true;
      console.log(`   [NOTIFICATION] First live account update received at +${Date.now() - pollStart}ms!`);
    }
    if (hud.performance.quoteValidEvaluations > 0 && !firstQuoteReceived) {
      firstQuoteReceived = true;
      console.log(`   [QUOTE] First valid quote produced at +${Date.now() - pollStart}ms! (Total: ${hud.performance.quoteValidEvaluations})`);
      break;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  clearInterval(scanTimer);

  const elapsed5 = Math.round(performance.now() - t5);
  const wsFinalStats = ws.getStats();
  const hudFinal = scanner.getHudV2Data();
  stageTimings.push({
    stage: '5. Confirmations & First Quote',
    elapsedMs: elapsed5,
    rpcTotal: 0,
    rpcFailed: 0,
    status: firstQuoteReceived ? 'SUCCESS' : (firstAccountUpdateReceived ? 'PARTIAL' : 'TIMEOUT'),
    detail: `Confirmed Subs: ${wsFinalStats.confirmedSubscriptionCount}/25, Active Accounts: ${wsFinalStats.activeAccountUpdatesCount}, Valid Quotes: ${hudFinal.performance.quoteValidEvaluations}`
  });

  const totalStartupMs = Math.round(performance.now() - tOverallStart);

  console.log('\n================================================================');
  console.log('STARTUP DIAGNOSTIC STAGE TIMINGS & RPC AUDIT');
  console.log('================================================================');
  console.log(`Total Initialization Time: ${totalStartupMs}ms (${(totalStartupMs / 1000).toFixed(2)}s)\n`);
  for (const st of stageTimings) {
    console.log(`  ${st.stage.padEnd(35)} | ${String(st.elapsedMs).padStart(5)}ms | RPC req: ${st.rpcTotal} (failed: ${st.rpcFailed}) | Status: ${st.status}`);
    if (st.detail) console.log(`     Detail: ${st.detail}`);
  }

  console.log('\n----------------------------------------------------------------');
  console.log('25-ACCOUNT SUBSCRIPTION COVERAGE & NOTIFICATION TELEMETRY:');
  console.log(`  Target Subscriptions:           ${(scanner as any).subscribedAccounts.size} accounts`);
  console.log(`  Registered WebSocket Subs:      ${wsFinalStats.subscriptionCount} accounts`);
  console.log(`  Confirmed WebSocket Subs:       ${wsFinalStats.confirmedSubscriptionCount} / ${config.MAX_WS_SUBSCRIPTIONS}`);
  console.log(`  Rejected WebSocket Subs:        ${wsFinalStats.rejectedSubscriptionCount}`);
  console.log(`  Accounts with Live Updates:     ${wsFinalStats.activeAccountUpdatesCount} accounts`);
  console.log(`  Total Messages Streamed:        ${wsFinalStats.messagesTotal} messages (${wsFinalStats.totalMegabytesReceived || 0} MB)`);
  console.log(`  Quote-Valid Evaluations:        ${hudFinal.performance.quoteValidEvaluations}`);
  console.log(`  Currently READY Routes:         ${hudFinal.routeHealth.readyRoutes}`);
  console.log('================================================================\n');

  scanner.stop();
  process.exit(0);
}

diagnoseStartup().catch(err => {
  console.error('Fatal diagnostic error:', err);
  process.exit(1);
});
