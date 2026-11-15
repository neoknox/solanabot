import fs from 'fs';
import path from 'path';
import { OpportunityWindowTracker } from './windowTracker.js';
import { OpportunityWindow, DurationPercentiles, StudyTelemetry } from '../types/index.js';

export interface StudyReportOutputPaths {
  csvPath: string;
  jsonPath: string;
  txtPath: string;
}

export class StudyReportGenerator {
  private tracker: OpportunityWindowTracker;
  private reportsDir: string;

  constructor(tracker: OpportunityWindowTracker, reportsDir = 'reports') {
    this.tracker = tracker;
    this.reportsDir = reportsDir;
  }

  public generateAllReports(): StudyReportOutputPaths {
    if (!fs.existsSync(this.reportsDir)) {
      fs.mkdirSync(this.reportsDir, { recursive: true });
    }

    const csvPath = path.join(this.reportsDir, 'solanabot_24h_opportunities.csv');
    const jsonPath = path.join(this.reportsDir, 'solanabot_24h_summary.json');
    const txtPath = path.join(this.reportsDir, 'solanabot_24h_report.txt');

    const telemetry = this.tracker.getTelemetry();
    const allWindows = [...this.tracker.getAllOpenWindows(), ...this.tracker.getAllClosedWindows()];
    const percentiles = this.tracker.calculateDurationPercentiles();

    this.writeCsv(csvPath, allWindows);
    this.writeJson(jsonPath, telemetry, percentiles, allWindows);
    this.writeTxt(txtPath, telemetry, percentiles, allWindows);

    return { csvPath, jsonPath, txtPath };
  }

  private writeCsv(filePath: string, windows: OpportunityWindow[]): void {
    const headers = [
      'window_id',
      'route_id',
      'token_symbol',
      'token_mint',
      'buy_dex',
      'buy_pool_id',
      'sell_dex',
      'sell_pool_id',
      'trade_size_usdc',
      'status',
      'closure_reason',
      'is_censored',
      'revalidation_status',
      'first_observed_utc',
      'last_observed_utc',
      'closed_at_utc',
      'duration_lower_bound_ms',
      'duration_upper_bound_ms',
      'net_profit_opening_usdc',
      'net_profit_peak_usdc',
      'net_profit_min_usdc',
      'net_profit_closing_usdc',
      'observation_count'
    ];

    const lines: string[] = [headers.join(',')];

    for (const w of windows) {
      const row = [
        `"${w.windowId}"`,
        `"${w.routeId}"`,
        `"${w.tokenSymbol}"`,
        `"${w.tokenMint}"`,
        `"${w.buyDex}"`,
        `"${w.buyPoolId}"`,
        `"${w.sellDex}"`,
        `"${w.sellPoolId}"`,
        w.tradeSizeUSDC.toFixed(2),
        `"${w.status}"`,
        `"${w.closureReason}"`,
        w.isCensored ? 1 : 0,
        `"${w.revalidationStatus}"`,
        `"${new Date(w.firstObservedAt).toISOString()}"`,
        `"${new Date(w.lastObservedAt).toISOString()}"`,
        w.closedAt ? `"${new Date(w.closedAt).toISOString()}"` : '""',
        w.durationLowerBoundMs,
        w.durationUpperBoundMs !== undefined ? w.durationUpperBoundMs : '',
        w.netProfitOpeningUSDC.toFixed(4),
        w.netProfitPeakUSDC.toFixed(4),
        w.netProfitMinUSDC.toFixed(4),
        w.netProfitClosingUSDC !== undefined ? w.netProfitClosingUSDC.toFixed(4) : '',
        w.observationCount
      ];
      lines.push(row.join(','));
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  }

  private writeJson(
    filePath: string,
    telemetry: StudyTelemetry,
    percentiles: DurationPercentiles,
    windows: OpportunityWindow[]
  ): void {
    const closed = windows.filter(w => w.status === 'CLOSED');
    const censored = windows.filter(w => w.status === 'INTERRUPTED_CENSORED');

    // Group closure reasons
    const closureBreakdown: Record<string, number> = {};
    for (const w of windows) {
      if (w.status !== 'OPEN') {
        closureBreakdown[w.closureReason] = (closureBreakdown[w.closureReason] || 0) + 1;
      }
    }

    // Trade size distribution
    const sizeDistribution: Record<number, number> = {};
    for (const w of windows) {
      sizeDistribution[w.tradeSizeUSDC] = (sizeDistribution[w.tradeSizeUSDC] || 0) + 1;
    }

    // Top 20 windows by peak net profit
    const top20 = [...windows]
      .sort((a, b) => b.netProfitPeakUSDC - a.netProfitPeakUSDC)
      .slice(0, 20);

    const summary = {
      studySessionId: telemetry.sessionId,
      status: telemetry.status,
      timestamp: new Date().toISOString(),
      coverage: {
        startedAtUtc: new Date(telemetry.startedAt).toISOString(),
        elapsedMs: telemetry.elapsedMs,
        elapsedHours: (telemetry.elapsedMs / 3600000).toFixed(2),
        targetDurationHours: (telemetry.targetDurationMs / 3600000).toFixed(2),
        healthyUptimeMs: telemetry.healthyUptimeMs,
        healthyUptimePct: telemetry.elapsedMs > 0 ? ((telemetry.healthyUptimeMs / telemetry.elapsedMs) * 100).toFixed(2) : '100.00',
        feedDowntimeMs: telemetry.feedDowntimeMs,
        disconnectCount: telemetry.disconnectCount
      },
      routesAndOpportunities: {
        totalObservedEvaluations: telemetry.totalObservedShadowOpportunities,
        totalQualifiedWindows: telemetry.totalQualifiedWindows,
        openWindowsAtEnd: telemetry.openQualifiedWindows,
        completedWindows: closed.length,
        censoredWindows: censored.length,
        nearMissesCount: telemetry.nearMissesCount,
        revalidationSuccessPct: telemetry.revalidationSuccessPct.toFixed(2)
      },
      durationMetrics: percentiles,
      closureReasons: closureBreakdown,
      sizeDistribution,
      profitability: {
        bestConservativeNetUSDC: telemetry.bestConservativeNetUSDC.toFixed(4)
      },
      top20Windows: top20
    };

    fs.writeFileSync(filePath, JSON.stringify(summary, null, 2), 'utf8');
  }

  private writeTxt(
    filePath: string,
    telemetry: StudyTelemetry,
    percentiles: DurationPercentiles,
    windows: OpportunityWindow[]
  ): void {
    const elapsedHours = (telemetry.elapsedMs / 3600000).toFixed(2);
    const healthyPct = telemetry.elapsedMs > 0 ? ((telemetry.healthyUptimeMs / telemetry.elapsedMs) * 100).toFixed(2) : '100.00';
    const closed = windows.filter(w => w.status === 'CLOSED');
    const censored = windows.filter(w => w.status === 'INTERRUPTED_CENSORED');

    // Group closure reasons
    const closureBreakdown: Record<string, number> = {};
    for (const w of windows) {
      if (w.status !== 'OPEN') {
        closureBreakdown[w.closureReason] = (closureBreakdown[w.closureReason] || 0) + 1;
      }
    }

    // Top 20
    const top20 = [...windows]
      .sort((a, b) => b.netProfitPeakUSDC - a.netProfitPeakUSDC)
      .slice(0, 20);

    const formatMs = (ms: number) => ms > 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;

    let txt = `================================================================================
SOLANABOT - 24-HOUR PROFITABILITY & OPPORTUNITY WINDOW STUDY REPORT
================================================================================
Generated At: ${new Date().toISOString()}
Session ID:   ${telemetry.sessionId}
Study Status: ${telemetry.status}

================================================================================
SECTION A: SCAN COVERAGE & OPERATIONAL HEALTH
================================================================================
Target Duration:             24:00:00 (86,400,000 ms)
Elapsed Scanning Time:       ${this.formatDuration(telemetry.elapsedMs)} (${elapsedHours} hours)
Healthy Scanning Uptime:     ${this.formatDuration(telemetry.healthyUptimeMs)} (${healthyPct}%)
Feed Downtime:               ${this.formatDuration(telemetry.feedDowntimeMs)}
WebSocket Disconnects:       ${telemetry.disconnectCount}
Data Integrity:              Fail-closed on stale dependencies, no unobserved gap assumptions.

================================================================================
SECTION B: ROUTE DISCOVERY & OPPORTUNITY FUNNEL
================================================================================
Candidate Evaluations:       ${telemetry.totalObservedShadowOpportunities}
Qualified 2-Leg Windows:     ${telemetry.totalQualifiedWindows}
Completed Market Windows:    ${closed.length}
Censored / Interrupted:      ${censored.length}
Still Open at Shutdown:      ${telemetry.openQualifiedWindows}
Near Misses (Net > 0 <$0.50):${telemetry.nearMissesCount}
Revalidation Survival Rate:  ${telemetry.revalidationSuccessPct.toFixed(1)}%

================================================================================
SECTION C: PROFITABILITY DISTRIBUTION & UNIT ECONOMICS
================================================================================
Best Conservative Net Profit:  $${telemetry.bestConservativeNetUSDC.toFixed(4)} USDC
Profit Hurdle Threshold:       $0.5000 USDC net
Safety Contingency Buffer:     $0.2500 USDC deducted per trade
DEX Fees & Priority Costs:     Fully deducted before qualification

`;

    txt += `================================================================================
SECTION D: OPPORTUNITY WINDOW DURATION ANALYSIS
(Calculated strictly from observed CLOSED windows; censored windows excluded)
================================================================================
Valid Closed Window Count:   ${percentiles.count}
Shortest Observed Window:    ${formatMs(percentiles.minMs)}
Median Observed Window:      ${formatMs(percentiles.medianMs)}
95th Percentile Window:      ${formatMs(percentiles.p95Ms)}
Longest Observed Window:     ${formatMs(percentiles.maxMs)}

Duration Breakdown:
  < 500 ms (Sub-second):     ${percentiles.under500msCount}
  500 ms - 2000 ms:          ${percentiles.between500msAnd2sCount}
  > 2000 ms (Persistent):    ${percentiles.over2sCount}

Window Closure Reasons:
`;

    if (Object.keys(closureBreakdown).length === 0) {
      txt += `  None observed.\n`;
    } else {
      for (const [reason, count] of Object.entries(closureBreakdown)) {
        txt += `  - ${reason.padEnd(26)} : ${count}\n`;
      }
    }

    txt += `
================================================================================
SECTION E: TOP MOST PROFITABLE OPPORTUNITY WINDOWS
================================================================================
`;

    if (top20.length === 0) {
      txt += `No qualified profitable opportunity windows were observed during this session.\n`;
    } else {
      txt += `Rank  Token    Route                   Size    Peak Net  Duration   Status & Reason\n`;
      txt += `----  -------  ----------------------  ------  --------  ---------  --------------------\n`;
      top20.forEach((w, idx) => {
        const rankStr = String(idx + 1).padStart(2);
        const tokenStr = w.tokenSymbol.padEnd(7);
        const routeStr = `${w.buyDex.substring(0, 3)}->${w.sellDex.substring(0, 3)}`.padEnd(22);
        const sizeStr = `$${w.tradeSizeUSDC}`.padEnd(6);
        const netStr = `$${w.netProfitPeakUSDC.toFixed(2)}`.padEnd(8);
        const dur = w.durationUpperBoundMs ?? w.durationLowerBoundMs;
        const durStr = formatMs(dur).padEnd(9);
        const reasonStr = `${w.status}: ${w.closureReason}`;
        txt += `${rankStr}    ${tokenStr}  ${routeStr}  ${sizeStr}  ${netStr}  ${durStr}  ${reasonStr}\n`;
      });
    }

    txt += `
================================================================================
SECTION F: ECONOMIC FEASIBILITY & STRATEGY RECOMMENDATIONS
================================================================================
1. Zero Guaranteed Profit:
   This study operates strictly in read-only shadow simulation mode. Realized
   profitability requires live execution with Solana transaction submission,
   priority fees, block builder contention, and actual execution slippage.

2. Contention & Execution Windows:
   Opportunities lasting under 500ms require sub-slot co-located execution or
   Jito bundle inclusion to capture before public pool arbitrage bots arbitrage
   the spread.

3. Capital Allocation:
   Opportunities across separate routes must not assume simultaneous capital reuse.
   Each atomic swap requires available USDC in the trading wallet.

4. Recommendation:
   Maintain strictly 2-leg atomic routes. Do not lower the $0.50 USDC safety hurdle.
================================================================================
`;

    fs.writeFileSync(filePath, txt, 'utf8');
  }

  private formatDuration(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
}
