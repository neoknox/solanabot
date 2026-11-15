import { config, AppConfig } from '../config/index.js';
import { ArbitrageScanner } from '../scanner/arbitrageScanner.js';
import { ProfitHudServer } from '../hud/profitHudServer.js';
import { OpportunityWindowTracker } from '../study/windowTracker.js';
import { StudyReportGenerator } from '../study/studyReportGenerator.js';
import { ArbitrageRepository } from '../storage/repository.js';

export interface StudyRunnerOptions {
  durationMs?: number;
  reportsDir?: string;
  config?: AppConfig;
}

export async function runStudy(options: StudyRunnerOptions = {}): Promise<void> {
  const customConfig = options.config || config;
  const reportsDir = options.reportsDir || 'reports';

  // Parse duration from options or process args
  let targetDurationMs = options.durationMs || 24 * 60 * 60 * 1000;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--duration-hours=')) {
      const hours = parseFloat(arg.split('=')[1]);
      if (!isNaN(hours) && hours > 0) targetDurationMs = Math.round(hours * 3600 * 1000);
    } else if (arg.startsWith('--duration-seconds=')) {
      const sec = parseFloat(arg.split('=')[1]);
      if (!isNaN(sec) && sec > 0) targetDurationMs = Math.round(sec * 1000);
    } else if (arg.startsWith('--reports-dir=')) {
      // reportsDir parsed
    }
  }

  const sessionId = `study_24h_${Date.now()}`;
  const repository = new ArbitrageRepository(customConfig);
  const windowTracker = new OpportunityWindowTracker({
    sessionId,
    targetDurationMs,
    profitHurdleUSDC: customConfig.MIN_NET_PROFIT_USDC || 0.50,
    quoteExpiryMs: customConfig.MAX_QUOTE_AGE_MS || 2500,
    repository
  });

  const scanner = new ArbitrageScanner(
    customConfig,
    undefined,
    undefined,
    undefined,
    repository,
    undefined,
    windowTracker
  );

  const thresholdManager = scanner.getProfitThresholdManager();
  const hudServer = new ProfitHudServer(thresholdManager, scanner, { port: customConfig.HUD_PORT });
  const reportGenerator = new StudyReportGenerator(windowTracker, reportsDir);

  const targetHours = (targetDurationMs / 3600000).toFixed(2);

  console.log('================================================================');
  console.log('  SOLANABOT - 24-HOUR PROFITABILITY & OPPORTUNITY WINDOW STUDY   ');
  console.log('  (Strictly Read-Only Shadow Scanning: Zero Live Trades)         ');
  console.log('================================================================');
  console.log(`Session ID:          ${sessionId}`);
  console.log(`Target Duration:     ${targetHours} hours (${targetDurationMs} ms)`);
  console.log(`Profit Hurdle:       ${thresholdManager.getFormattedThreshold()} net`);
  console.log(`Safety Buffer:       $${customConfig.SAFETY_BUFFER_USDC.toFixed(2)} USDC per trade`);
  console.log(`Trade Sizes:         $${customConfig.parsedTradeSizesUSDC.join(', $')} USDC`);
  console.log(`HUD Terminal URL:    http://127.0.0.1:${customConfig.HUD_PORT}`);
  console.log(`Reports Target:      ${reportsDir}/`);
  console.log('----------------------------------------------------------------\n');

  // Start HUD first
  await hudServer.start();

  // Start Scanner
  await scanner.start();

  console.log('>> Scanner and HUD running. Collecting continuous opportunity windows...\n');

  let isTerminating = false;

  const flushAndReport = (reason: 'COMPLETED' | 'INTERRUPTED') => {
    if (isTerminating) return;
    isTerminating = true;

    console.log(`\n================================================================`);
    console.log(`>> Session ${reason}. Finalizing 24-Hour Study & Generating Reports...`);
    console.log(`================================================================`);

    // Terminate study window tracking
    windowTracker.completeStudy(reason === 'COMPLETED' ? 'STUDY_COMPLETED' : 'SCANNER_STOP');

    // Generate all 3 report files
    const outputs = reportGenerator.generateAllReports();
    console.log(`CSV Report:     ${outputs.csvPath}`);
    console.log(`JSON Summary:   ${outputs.jsonPath}`);
    console.log(`TXT Report:     ${outputs.txtPath}`);

    const telem = windowTracker.getTelemetry();
    console.log(`\n--- STUDY TELEMETRY SUMMARY ---`);
    console.log(`Total Candidates Evaluated:    ${telem.totalObservedShadowOpportunities}`);
    console.log(`Total Qualified Windows:       ${telem.totalQualifiedWindows}`);
    console.log(`Completed Market Windows:      ${telem.completedQualifiedWindows}`);
    console.log(`Censored / Interrupted Windows:${telem.censoredWindows}`);
    console.log(`Best Conservative Net Profit:  $${telem.bestConservativeNetUSDC.toFixed(4)} USDC`);
    console.log(`Revalidation Survival Rate:    ${telem.revalidationSuccessPct.toFixed(1)}%`);
    console.log(`Median Window Duration:        ${telem.medianDurationMs} ms`);
    console.log(`95th Percentile Duration:      ${telem.p95DurationMs} ms`);
    console.log(`Scanning Healthy Uptime:       ${(telem.healthyUptimeMs / 1000).toFixed(1)}s (${((telem.healthyUptimeMs / Math.max(1, telem.elapsedMs)) * 100).toFixed(1)}%)`);
    console.log(`Feed Downtime:                 ${(telem.feedDowntimeMs / 1000).toFixed(1)}s (${telem.disconnectCount} disconnects)`);
    console.log(`================================================================\n`);
  };

  // Periodic console progress log (every 30 seconds)
  const progressTimer = setInterval(() => {
    if (!scanner.isScannerRunning() || isTerminating) return;
    const telem = windowTracker.getTelemetry();
    const elapsedSec = Math.floor(telem.elapsedMs / 1000);
    const targetSec = Math.floor(targetDurationMs / 1000);
    const pct = Math.min(100, ((telem.elapsedMs / targetDurationMs) * 100)).toFixed(1);
    const healthyPct = telem.elapsedMs > 0 ? ((telem.healthyUptimeMs / telem.elapsedMs) * 100).toFixed(1) : '100.0';

    console.log(
      `[${new Date().toISOString()}] Progress: ${pct}% (${elapsedSec}s / ${targetSec}s) | ` +
      `Uptime: ${healthyPct}% | Drops: ${telem.disconnectCount} | ` +
      `Windows: ${telem.totalQualifiedWindows} qual (${telem.openQualifiedWindows} live, ${telem.completedQualifiedWindows} closed, ${telem.censoredWindows} censored) | ` +
      `BestNet: $${telem.bestConservativeNetUSDC.toFixed(2)}`
    );
  }, 30000);
  progressTimer.unref();

  // Schedule automatic stop at target duration
  const deadlineTimer = setTimeout(async () => {
    clearInterval(progressTimer);
    flushAndReport('COMPLETED');
    try {
      await hudServer.stop();
      scanner.stop();
    } catch {}
    process.exit(0);
  }, targetDurationMs);
  deadlineTimer.unref();

  // Signal handlers
  const handleShutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Gracefully stopping study...`);
    clearTimeout(deadlineTimer);
    clearInterval(progressTimer);
    flushAndReport('INTERRUPTED');
    try {
      await hudServer.stop();
      scanner.stop();
    } catch {}
    process.exit(0);
  };

  process.once('SIGINT', () => handleShutdown('SIGINT'));
  process.once('SIGTERM', () => handleShutdown('SIGTERM'));
}

// Run CLI if invoked directly
if (!process.env.VITEST) {
  runStudy().catch((err) => {
    console.error('Fatal study error:', err);
    process.exit(1);
  });
}
