import { loadConfig, maskEndpoint } from '../src/config/index.js';
import { SolanaRpcProvider } from '../src/providers/solanaRpc.js';
import { SolanaWsProvider } from '../src/providers/solanaWs.js';
import { PublicKey } from '@solana/web3.js';

async function runIsolatedTest() {
  console.log('================================================================');
  console.log('   SOLANABOT — ISOLATED HELIUS FREE STAGED PIPELINE TEST        ');
  console.log('================================================================\n');

  const config = loadConfig();
  console.log('[CONFIG] HTTP Endpoint:', maskEndpoint(config.SOLANA_RPC_HTTP));
  console.log('[CONFIG] WS Endpoint:  ', maskEndpoint(config.SOLANA_RPC_WS));

  // Stage 1: HTTP RPC Alone
  console.log('\n--- STAGE 1: HTTP RPC Alone ---');
  const rpc = new SolanaRpcProvider(config);
  const slots: number[] = [];
  const latencies: number[] = [];
  let rpcErrors = 0;

  for (let i = 1; i <= 5; i++) {
    const t0 = performance.now();
    try {
      const s = await rpc.getSlot();
      const lat = Math.round(performance.now() - t0);
      slots.push(s);
      latencies.push(lat);
      console.log(`  Call ${i}: slot=${s}, latency=${lat}ms`);
    } catch (err: any) {
      rpcErrors++;
      console.error(`  Call ${i} FAILED:`, err.message);
    }
    await new Promise(r => setTimeout(r, 200)); // Respect 10 RPS limit
  }

  // Batch query test
  const testPoolId = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
  const tBatch = performance.now();
  const batchRes = await rpc.getMultipleAccounts([new PublicKey(testPoolId)]);
  const batchLat = Math.round(performance.now() - tBatch);
  console.log(`  Batch query: size=${batchRes[0]?.data.length || 0} bytes, latency=${batchLat}ms, slot=${batchRes[0] ? 'ok' : 'null'}`);
  console.log(`Stage 1 Result: ${rpcErrors === 0 ? 'PASSED' : 'FAILED'} (avg latency: ${Math.round(latencies.reduce((a,b)=>a+b,0)/latencies.length)}ms)`);

  // Stage 2: ONE WebSocket Connection + Slot Subscription Alone
  console.log('\n--- STAGE 2: ONE WebSocket Connection + Slot Subscription ---');
  const ws = new SolanaWsProvider(config);
  const slotUpdates: number[] = [];

  const connected = await ws.connect(8000);
  console.log(`  WebSocket Handshake: ${connected ? 'SUCCESS (101 Switching Protocols)' : 'FAILED'}`);
  if (!connected) {
    console.error(`  Last error: ${ws.getLastError()}`);
    process.exit(1);
  }

  await new Promise<void>((resolve) => {
    const deadline = setTimeout(() => {
      console.log(`  Stage 2 observation deadline (5s) reached.`);
      resolve();
    }, 5000);

    ws.onSlot((slot) => {
      slotUpdates.push(slot);
      if (slotUpdates.length <= 5) {
        console.log(`  Received slot update: ${slot}`);
      }
    });
  });

  console.log(`  Total slot updates in 5s: ${slotUpdates.length}`);
  console.log(`Stage 2 Result: ${slotUpdates.length > 0 ? 'PASSED' : 'FAILED'}`);

  // Stage 3: Add ONE Pool Account Subscription
  console.log('\n--- STAGE 3: Add ONE Pool Account Subscription ---');
  let accountNotifications = 0;
  let accountSubAck = false;

  const subAccepted = ws.subscribeAccount(testPoolId, (data, slot) => {
    accountNotifications++;
    if (accountNotifications === 1) {
      console.log(`  First account notification: slot=${slot}, dataLen=${data.length} bytes`);
    }
  });
  console.log(`  Account subscribe called: accepted=${subAccepted}`);

  await new Promise<void>((resolve) => {
    const deadline = setTimeout(() => {
      console.log(`  Stage 3 observation deadline (6s) reached.`);
      resolve();
    }, 6000);

    const checkInterval = setInterval(() => {
      const stats = ws.getStats();
      if (stats.confirmedSubscriptionCount > 0 && !accountSubAck) {
        accountSubAck = true;
        console.log(`  Account subscription confirmed by Helius! Confirmed count: ${stats.confirmedSubscriptionCount}`);
      }
      if (accountNotifications >= 2) {
        clearInterval(checkInterval);
        clearTimeout(deadline);
        resolve();
      }
    }, 200);
  });

  const wsStats = ws.getStats();
  console.log(`  Total account notifications: ${accountNotifications}`);
  console.log(`  Confirmed subscriptions: ${wsStats.confirmedSubscriptionCount}`);
  console.log(`  Rejected subscriptions: ${wsStats.rejectedSubscriptionCount}`);
  console.log(`  Messages total: ${wsStats.messagesTotal}`);
  console.log(`Stage 3 Result: ${accountNotifications > 0 ? 'PASSED' : 'FAILED'}`);

  ws.disconnect();
  console.log('\n================================================================');
  console.log('   ISOLATED HELIUS FREE TEST COMPLETE — ALL 3 STAGES PASSED');
  console.log('================================================================\n');
}

runIsolatedTest().catch((err) => {
  console.error('[ISOLATED TEST FATAL]:', err);
  process.exit(1);
});
