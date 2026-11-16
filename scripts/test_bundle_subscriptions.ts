import { loadConfig } from '../src/config/index.js';
import { PoolRegistry } from '../src/scanner/poolRegistry.js';
import { loadDiscoveredCandidates } from '../src/scanner/poolDiscovery.js';
import { SolanaWsProvider } from '../src/providers/solanaWs.js';
import { SolanaRpcProvider } from '../src/providers/solanaRpc.js';
import { dexRegistry } from '../src/dex/index.js';
import { PublicKey } from '@solana/web3.js';
import { deriveTickArrayPda, getSurroundingTickArrayStartIndices } from '../src/dex/orcaTickArray.js';
import { deriveRaydiumClmmTickArrayPda, getSurroundingRaydiumClmmTickArrayStartIndices } from '../src/dex/raydiumClmmTickArray.js';

async function main() {
  const config = loadConfig({ MAX_WS_SUBSCRIPTIONS: '25' });
  const rpc = new SolanaRpcProvider(config);
  const registry = new PoolRegistry();
  const discPath = 'C:/Users/HP/solanabot/data/discovered_pools.json';
  registry.loadDiscoveredCandidates(loadDiscoveredCandidates(discPath));

  const allPools = registry.getAllPools();
  console.log(`Loaded ${allPools.length} pools.`);

  // 1. Snapshot hydration via RPC
  const pubkeys = allPools.map(p => new PublicKey(p.id));
  const rpcRes = await rpc.getMultipleAccountsAndContext(pubkeys);
  const poolStates: Record<string, any> = {};

  for (let i = 0; i < allPools.length; i++) {
    const p = allPools[i];
    const acc = rpcRes.value[i];
    if (!acc) continue;
    const adapter = dexRegistry.getAdapter(p.dex);
    const decoded = adapter?.decodePoolState(acc.data, p.id, rpcRes.slot);
    if (decoded) {
      poolStates[p.id] = decoded;
    }
  }

  // Priority pool order: High volume pairs
  const priorityPoolIds = [
    'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', // Orca Whirlpool 0.04% SOL/USDC
    '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2', // Raydium AMM Main SOL/USDC
    'FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q', // Orca Whirlpool 0.02% SOL/USDC
    '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv', // Raydium CLMM SOL/USDC
    '4fuUiYxTQ6QCrdSq9ouBYcTM7bqSwYTSyLueGZLTy4T4', // Orca Whirlpool USDC/USDT
    '7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX', // Raydium AMM WSOL/USDT
    '7TbGqz32RsuwXbXY7EyBCiAnMbJq1gm1wKmfjQjuwoyF'  // Raydium AMM Secondary SOL/USDC
  ];

  const maxSubs = 25;
  const subscribedAccounts = new Set<string>();
  const poolBundles: Array<{ poolId: string; dex: string; accounts: Array<{ key: string; type: string }> }> = [];

  for (const poolId of priorityPoolIds) {
    const p = registry.getPool(poolId);
    const state = poolStates[poolId];
    if (!p || !state) continue;

    const bundle: Array<{ key: string; type: string }> = [];
    bundle.push({ key: poolId, type: 'POOL_ACCOUNT' });

    const extra = state.extraData || {};
    if (p.dex === 'RAYDIUM_AMM') {
      if (extra.baseVault) bundle.push({ key: extra.baseVault, type: 'VAULT_ACCOUNT' });
      if (extra.quoteVault) bundle.push({ key: extra.quoteVault, type: 'VAULT_ACCOUNT' });
      if (extra.openOrders) bundle.push({ key: extra.openOrders, type: 'OPENORDERS_ACCOUNT' });
    } else if (p.dex === 'ORCA_WHIRLPOOL') {
      const tickCurrent = extra.tickCurrent;
      const tickSpacing = extra.tickSpacing || 1;
      if (tickCurrent !== undefined) {
        const surrounding = getSurroundingTickArrayStartIndices(tickCurrent, tickSpacing);
        const currentStart = surrounding[2];
        const pda = deriveTickArrayPda(poolId, currentStart);
        bundle.push({ key: pda.toBase58(), type: 'TICK_ARRAY_ACCOUNT' });
      }
    } else if (p.dex === 'RAYDIUM_CLMM') {
      const tickCurrent = extra.tickCurrent;
      const tickSpacing = extra.tickSpacing || 1;
      if (tickCurrent !== undefined) {
        const surrounding = getSurroundingRaydiumClmmTickArrayStartIndices(tickCurrent, tickSpacing);
        const currentStart = surrounding[2];
        const pda = deriveRaydiumClmmTickArrayPda(poolId, currentStart);
        bundle.push({ key: pda.toBase58(), type: 'TICK_ARRAY_ACCOUNT' });
      }
      if (extra.baseVault) bundle.push({ key: extra.baseVault, type: 'VAULT_ACCOUNT' });
      if (extra.quoteVault) bundle.push({ key: extra.quoteVault, type: 'VAULT_ACCOUNT' });
      if (extra.ammConfig) bundle.push({ key: extra.ammConfig, type: 'AMM_CONFIG_ACCOUNT' });
    }

    // Check if new accounts fit in remaining slots
    const newAccounts = bundle.filter(a => !subscribedAccounts.has(a.key));
    if (subscribedAccounts.size + newAccounts.length <= maxSubs) {
      for (const a of newAccounts) {
        subscribedAccounts.add(a.key);
      }
      poolBundles.push({ poolId, dex: p.dex, accounts: bundle });
    } else {
      console.log(`Pool ${poolId} bundle (${newAccounts.length} new accounts) exceeds remaining capacity (${maxSubs - subscribedAccounts.size})`);
      break;
    }
  }

  console.log(`\n=== BUNDLE SUBSCRIPTION PLAN ===`);
  console.log(`Total fully subscribed pools: ${poolBundles.length}`);
  console.log(`Total active WS subscriptions: ${subscribedAccounts.size} / ${maxSubs}`);

  for (const b of poolBundles) {
    console.log(`\nPool ${b.poolId} [${b.dex}] (${b.accounts.length} accounts):`);
    for (const a of b.accounts) {
      console.log(`  - [${a.type}] ${a.key}`);
    }
  }
}

main().catch(console.error);
