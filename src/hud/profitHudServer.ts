import http from 'http';
import { URL } from 'url';
import { ProfitThresholdManager, VALID_PROFIT_THRESHOLDS_CENTS } from '../profit/profitThresholdManager.js';
import { ArbitrageScanner } from '../scanner/arbitrageScanner.js';

export interface ProfitHudServerOptions {
  port?: number;
  host?: string;
  silent?: boolean;
}

export class ProfitHudServer {
  private server: http.Server | null = null;
  private thresholdManager: ProfitThresholdManager;
  private scanner?: ArbitrageScanner;
  private port: number;
  private host: string;
  private boundPort: number | null = null;
  private silent: boolean;

  constructor(
    thresholdManager: ProfitThresholdManager,
    scanner?: ArbitrageScanner,
    options: ProfitHudServerOptions = {}
  ) {
    this.thresholdManager = thresholdManager;
    this.scanner = scanner;
    this.port = options.port ?? (process.env.HUD_PORT ? parseInt(process.env.HUD_PORT, 10) : 3030);
    this.host = '127.0.0.1'; // Strictly bound to 127.0.0.1 (never expose public or remote endpoint)
    this.silent = options.silent ?? false;
  }

  /**
   * Starts the localhost HTTP HUD server.
   */
  public async start(): Promise<{ port: number; host: string; url: string }> {
    if (this.server) {
      return {
        port: this.boundPort || this.port,
        host: this.host,
        url: `http://${this.host}:${this.boundPort || this.port}`
      };
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (err) => {
        if (!this.silent) {
          console.error('[ProfitHudServer] Server error:', err);
        }
        reject(err);
      });

      this.server.listen(this.port, this.host, () => {
        const addr = this.server?.address();
        if (typeof addr === 'object' && addr !== null) {
          this.boundPort = addr.port;
        } else {
          this.boundPort = this.port;
        }

        const url = `http://${this.host}:${this.boundPort}`;
        if (!this.silent) {
          console.log(`[ProfitHudServer] HUD active at ${url} [READ-ONLY / SHADOW MODE]`);
        }
        resolve({ port: this.boundPort, host: this.host, url });
      });
    });
  }

  /**
   * Stops the HTTP HUD server.
   */
  public async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise((resolve) => {
      this.server?.close(() => {
        this.server = null;
        this.boundPort = null;
        resolve();
      });
    });
  }

  public getPort(): number | null {
    return this.boundPort;
  }

  public getUrl(): string {
    return `http://${this.host}:${this.boundPort || this.port}`;
  }

  /**
   * Validates that state-changing requests originate strictly from localhost / 127.0.0.1.
   */
  private isOriginAllowed(req: http.IncomingMessage): boolean {
    const origin = req.headers['origin'];
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
          return false;
        }
      } catch {
        return false;
      }
    }

    const host = req.headers['host'];
    if (host) {
      const hostname = host.split(':')[0];
      if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
        return false;
      }
    }

    return true;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const parsedUrl = new URL(req.url || '/', `http://${this.host}:${this.boundPort || this.port}`);
    const pathname = parsedUrl.pathname;
    const method = req.method?.toUpperCase();

    // CORS & Security Headers (Restricted to localhost)
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': req.headers['origin'] || `http://${this.host}:${this.boundPort || this.port}`,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }

    // 1. GET /api/threshold
    if (pathname === '/api/threshold' && method === 'GET') {
      const payload = {
        success: true,
        mode: 'READ-ONLY / SHADOW MODE',
        thresholdUSDC: this.thresholdManager.getThresholdUSDC(),
        thresholdCents: this.thresholdManager.getThresholdCents(),
        formatted: this.thresholdManager.getFormattedThreshold(),
        minUSDC: 0.20,
        maxUSDC: 0.70,
        stepUSDC: 0.05,
        allowedStepsUSDC: VALID_PROFIT_THRESHOLDS_CENTS.map(c => c / 100)
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }

    // 2. POST /api/threshold (Live runtime adjustment)
    if (pathname === '/api/threshold' && method === 'POST') {
      // Security: Origin validation
      if (!this.isOriginAllowed(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: 'Forbidden: State-changing requests restricted strictly to 127.0.0.1 / localhost Origin'
        }));
        return;
      }

      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 16384) {
          req.destroy();
        }
      });

      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const candidateVal = parsed.thresholdUSDC !== undefined
            ? parsed.thresholdUSDC
            : (parsed.cents !== undefined ? parsed.cents : undefined);

          const result = this.thresholdManager.setThreshold(candidateVal);

          if (!result.success) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: result.error,
              thresholdUSDC: result.thresholdUSDC,
              thresholdCents: result.thresholdCents,
              formatted: result.formatted
            }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            thresholdUSDC: result.thresholdUSDC,
            thresholdCents: result.thresholdCents,
            formatted: result.formatted,
            mode: 'READ-ONLY / SHADOW MODE'
          }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: `Malformed JSON request payload: ${err instanceof Error ? err.message : String(err)}`,
            thresholdUSDC: this.thresholdManager.getThresholdUSDC(),
            thresholdCents: this.thresholdManager.getThresholdCents(),
            formatted: this.thresholdManager.getFormattedThreshold()
          }));
        }
      });
      return;
    }

    // 3. GET /api/status (Live telemetry & active signal counts)
    if (pathname === '/api/status' && method === 'GET') {
      const health = this.scanner ? this.scanner.getHealthStatus() : null;
      const tracker = this.scanner ? this.scanner.getOpportunityTracker() : null;
      const activeOpportunities = tracker ? tracker.getAllActiveOpportunities() : [];
      const qualifiedActiveShadow = activeOpportunities.filter(o => o.status === 'QUALIFIED_SHADOW');

      const payload = {
        success: true,
        mode: 'READ-ONLY / SHADOW MODE',
        thresholdUSDC: this.thresholdManager.getThresholdUSDC(),
        thresholdCents: this.thresholdManager.getThresholdCents(),
        formatted: this.thresholdManager.getFormattedThreshold(),
        solanaSlot: health ? health.currentSlot : null,
        wsConnected: health ? health.connectedWs : false,
        rpcStatus: health ? (health.connectedRpc ? 'ACTIVE' : 'DEGRADED') : 'STANDBY',
        qualifiedCount: health ? health.qualifiedCount : 0,
        rejectedCount: health ? health.rejectedCount : 0,
        activeAllocatedCapitalUSDC: tracker ? tracker.getActiveAllocatedCapital() : 0,
        activeShadowSignalsCount: qualifiedActiveShadow.length
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }

    // 4. GET / (Minimal localhost HTML control page)
    if (pathname === '/' && method === 'GET') {
      const html = this.renderHtmlDashboard();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // Default 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Endpoint not found' }));
  }

  /**
   * Renders a lightweight, zero-dependency HTML monitoring HUD.
   */
  private renderHtmlDashboard(): string {
    const currentUSDC = this.thresholdManager.getThresholdUSDC().toFixed(2);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SolanaBot - Profit Threshold HUD</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-bright: #ffffff;
      --accent: #58a6ff;
      --amber: #f59e0b;
      --green: #238636;
      --red: #da3633;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 24px;
      line-height: 1.5;
    }
    .container {
      max-width: 680px;
      margin: 0 auto;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .header h1 {
      font-size: 20px;
      color: var(--text-bright);
      font-weight: 600;
    }
    .badge-shadow {
      background-color: rgba(245, 158, 11, 0.15);
      color: var(--amber);
      border: 1px solid rgba(245, 158, 11, 0.4);
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .card {
      background-color: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 20px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }
    .card-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-bright);
      margin-bottom: 8px;
    }
    .card-desc {
      font-size: 13px;
      color: #8b949e;
      margin-bottom: 20px;
    }
    .display-readout {
      text-align: center;
      margin: 16px 0;
    }
    .amount-large {
      font-size: 42px;
      font-weight: 700;
      color: var(--text-bright);
      font-variant-numeric: tabular-nums;
    }
    .badge-confirmed {
      display: inline-block;
      margin-top: 6px;
      font-size: 12px;
      padding: 3px 8px;
      border-radius: 6px;
      background-color: rgba(35, 134, 54, 0.2);
      color: #3fb950;
      border: 1px solid rgba(35, 134, 54, 0.4);
      font-variant-numeric: tabular-nums;
    }
    .slider-container {
      margin: 28px 0 16px 0;
    }
    input[type=range] {
      width: 100%;
      height: 8px;
      border-radius: 4px;
      background: #21262d;
      outline: none;
      -webkit-appearance: none;
      cursor: pointer;
    }
    input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: var(--accent);
      cursor: pointer;
      box-shadow: 0 0 6px rgba(88, 166, 255, 0.6);
      transition: transform 0.1s;
    }
    input[type=range]::-webkit-slider-thumb:hover {
      transform: scale(1.15);
    }
    .ticks {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: #8b949e;
      margin-top: 8px;
      padding: 0 4px;
      font-variant-numeric: tabular-nums;
    }
    .alert {
      padding: 12px 14px;
      border-radius: 6px;
      font-size: 13px;
      margin-top: 16px;
      display: none;
    }
    .alert-success {
      background-color: rgba(35, 134, 54, 0.15);
      border: 1px solid rgba(35, 134, 54, 0.4);
      color: #3fb950;
    }
    .alert-error {
      background-color: rgba(218, 54, 51, 0.15);
      border: 1px solid rgba(218, 54, 51, 0.4);
      color: #f85149;
    }
    .info-footer {
      font-size: 12px;
      color: #8b949e;
      text-align: center;
      margin-top: 24px;
      border-top: 1px solid var(--border);
      padding-top: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>SolanaBot Monitoring HUD</h1>
      <span class="badge-shadow">READ-ONLY / SHADOW MODE</span>
    </div>

    <div class="card">
      <div class="card-title">Minimum Conservative Net Profit Floor</div>
      <div class="card-desc">
        Adjustable hurdle for candidate qualification and survival verification. Changes take effect immediately for new evaluations without restarting the scanner.
      </div>

      <div class="display-readout">
        <div class="amount-large" id="currentDisplay">$${currentUSDC} USDC</div>
        <div class="badge-confirmed" id="confirmedBadge">Confirmed Active: $${currentUSDC} USDC</div>
      </div>

      <div class="slider-container">
        <input 
          type="range" 
          id="thresholdSlider" 
          min="0.20" 
          max="0.70" 
          step="0.05" 
          value="${currentUSDC}" 
          aria-label="Minimum Conservative Net Profit"
        >
        <div class="ticks">
          <span>$0.20</span>
          <span>$0.30</span>
          <span>$0.40</span>
          <span>$0.50 (Default)</span>
          <span>$0.60</span>
          <span>$0.70</span>
        </div>
      </div>

      <div id="alertBox" class="alert"></div>
    </div>

    <div class="info-footer">
      Strictly Read-Only Simulation &bull; Local Interface 127.0.0.1 &bull; Zero Private Keys &bull; No Funds at Risk
    </div>
  </div>

  <script>
    (function() {
      const slider = document.getElementById('thresholdSlider');
      const display = document.getElementById('currentDisplay');
      const confirmedBadge = document.getElementById('confirmedBadge');
      const alertBox = document.getElementById('alertBox');

      let activeConfirmed = parseFloat(slider.value);
      let isUpdating = false;

      function showAlert(msg, isError) {
        alertBox.textContent = msg;
        alertBox.className = isError ? 'alert alert-error' : 'alert alert-success';
        alertBox.style.display = 'block';
      }

      function hideAlert() {
        alertBox.style.display = 'none';
      }

      slider.addEventListener('input', function(e) {
        const val = parseFloat(e.target.value).toFixed(2);
        display.textContent = '$' + val + ' USDC';
      });

      slider.addEventListener('change', async function(e) {
        if (isUpdating) return;
        const targetValue = parseFloat(e.target.value);
        isUpdating = true;
        slider.disabled = true;

        try {
          const res = await fetch('/api/threshold', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ thresholdUSDC: targetValue })
          });

          const data = await res.json();

          if (res.ok && data.success) {
            activeConfirmed = data.thresholdUSDC;
            const formatted = '$' + activeConfirmed.toFixed(2) + ' USDC';
            display.textContent = formatted;
            slider.value = activeConfirmed.toFixed(2);
            confirmedBadge.textContent = 'Confirmed Active: ' + formatted;
            showAlert('Active threshold updated to ' + formatted + ' (no restart required).', false);
          } else {
            // Revert slider to last backend-confirmed value
            slider.value = activeConfirmed.toFixed(2);
            display.textContent = '$' + activeConfirmed.toFixed(2) + ' USDC';
            showAlert('Update rejected: ' + (data.error || 'Invalid setting'), true);
          }
        } catch (err) {
          slider.value = activeConfirmed.toFixed(2);
          display.textContent = '$' + activeConfirmed.toFixed(2) + ' USDC';
          showAlert('Communication error: ' + (err.message || 'Could not reach local server'), true);
        } finally {
          slider.disabled = false;
          isUpdating = false;
        }
      });
    })();
  </script>
</body>
</html>`;
  }
}
