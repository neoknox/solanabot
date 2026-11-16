async function fetchHud() {
  try {
    const res = await fetch('http://127.0.0.1:3030/api/status');
    const data = await res.json();
    console.log('--- LIVE HUD TELEMETRY FROM PORT 3030 ---');
    console.log('wsStatus:     ', data.wsStatus);
    console.log('wsConnected:  ', data.wsConnected);
    console.log('solanaSlot:   ', data.solanaSlot);
    console.log('rpcStatus:    ', data.rpcStatus);
    console.log('sessionUptime:', data.sessionUptimeFormatted);
    console.log('diagnostics:  ', JSON.stringify(data.diagnostics, null, 2));
    console.log('performance:  ', JSON.stringify(data.performance, null, 2));
    console.log('routeHealth:  ', JSON.stringify(data.routeHealth, null, 2));
    console.log('study:        ', JSON.stringify({
      feedDowntimeMs: data.study?.feedDowntimeMs,
      healthyUptimeMs: data.study?.healthyUptimeMs,
      totalDrops: data.study?.totalDrops,
      healthyCoveragePct: data.study?.healthyCoveragePct
    }, null, 2));
  } catch (err: any) {
    console.error('Failed to fetch from port 3030:', err.message);
  }
}

fetchHud();
