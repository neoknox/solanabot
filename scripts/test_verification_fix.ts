import { loadConfig } from '../src/config/index.js';
import { SolanaRpcProvider } from '../src/providers/solanaRpc.js';
import { PoolRegistry } from '../src/scanner/poolRegistry.js';
import { loadDiscoveredCandidates } from '../src/scanner/poolDiscovery.js';
import { PublicKey } from '@solana/web3.js';
import { dexRegistry } from '../src/dex/index.js';
import { KNOWN_PROGRAM_IDS } from '../src/config/index.js';
import {
  deriveTickArrayPda,
  getTickArrayStartTickIndex,
  getSurroundingTickArrayStartIndices,
  decodeTickArrayAccount
} from '../src/dex/orcaTickArray.js';
import {
  deriveRaydiumClmmTickArrayPda,
  getRaydiumClmmTickArrayStartIndex,
  getSurroundingRaydiumClmmTickArrayStartIndices,
  decodeRaydiumClmmTickArray
} from '../src/dex/raydiumClmmTickArray.js';

async function main() {
  const config = loadConfig();
  const rpc = new SolanaRpcProvider(config);
  const registry = new PoolRegistry();
  const discPath = 'C:/Users/HP/solanabot/data/discovered_pools.json';
  registry.loadDiscoveredCandidates(loadDiscoveredCandidates(discPath));

  const pools = registry.getAllPools();
  console.log(`Auditing all ${pools.length} pools...`);

  const poolPubkeys = pools.map(p => new PublicKey(p.id));
  const rpcRes = await rpc.getMultipleAccountsAndContext(poolPubkeys);
  const snapshotSlot = rpcRes.slot;
  const accounts = rpcRes.value;

  const vaultsToFetch: { pubkey: PublicKey; poolIndex: number; isA: boolean }[] = [];
  const openOrdersToFetch: { pubkey: PublicKey; poolIndex: number; expectedOwner: string }[] = [];
  const decodedPools: any[] = [];

  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    const acc = accounts[i];
    if (!acc) continue;

    const adapter = dexRegistry.getAdapter(p.dex);
    if (!adapter) continue;

    const decoded = adapter.decodePoolState(acc.data, p.id, snapshotSlot);
    if (!decoded) continue;

    const extra = decoded.extraData as any;
    const vA = extra?.baseVault || extra?.tokenVaultA || extra?.reserveX;
    const vB = extra?.quoteVault || extra?.tokenVaultB || extra?.reserveY;

    if (p.dex === 'RAYDIUM_AMM' && extra?.openOrders) {
      openOrdersToFetch.push({
        pubkey: new PublicKey(extra.openOrders),
        poolIndex: decodedPools.length,
        expectedOwner: extra.marketProgramId || 'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'
      });
    }

    if (vA && vB) {
      vaultsToFetch.push({ pubkey: new PublicKey(vA), poolIndex: decodedPools.length, isA: true });
      vaultsToFetch.push({ pubkey: new PublicKey(vB), poolIndex: decodedPools.length, isA: false });
    }

    decodedPools.push(decoded);
  }

  console.log(`Fetching ${vaultsToFetch.length} vaults via RPC...`);
  const vRes = await rpc.getMultipleAccountsAndContext(vaultsToFetch.map(v => v.pubkey));
  for (let i = 0; i < vaultsToFetch.length; i++) {
    const vInfo = vaultsToFetch[i];
    const acc = vRes.value[i];
    if (acc && acc.data.length >= 72) {
      const amount = acc.data.readBigUInt64LE(64);
      const pool = decodedPools[vInfo.poolIndex];
      const extra = pool.extraData || {};
      if (vInfo.isA) {
        pool.reserveA = amount;
        extra.vaultASlot = vRes.slot;
        extra.vaultAReceivedAt = Date.now();
      } else {
        pool.reserveB = amount;
        extra.vaultBSlot = vRes.slot;
        extra.vaultBReceivedAt = Date.now();
      }
    }
  }

  console.log(`Fetching ${openOrdersToFetch.length} open orders via RPC...`);
  const ooRes = await rpc.getMultipleAccountsAndContext(openOrdersToFetch.map(o => o.pubkey));
  for (let i = 0; i < openOrdersToFetch.length; i++) {
    const ooInfo = openOrdersToFetch[i];
    const acc = ooRes.value[i];
    const pool = decodedPools[ooInfo.poolIndex];
    if (acc && acc.data.length >= 3228) {
      const extra = pool.extraData || {};
      extra.openOrdersVerified = true;
      extra.openOrdersSlot = ooRes.slot;
      extra.verifiedAt = Date.now();
    }
  }

  // Fetch Tick Arrays for concentrated pools
  const tickArraysToFetch: { pda: PublicKey; poolIndex: number; startIdx: number; isClmm: boolean }[] = [];
  for (let pIdx = 0; pIdx < decodedPools.length; pIdx++) {
    const pool = decodedPools[pIdx];
    if (pool.dex === 'ORCA_WHIRLPOOL' || pool.dex === 'RAYDIUM_CLMM') {
      const isClmm = pool.dex === 'RAYDIUM_CLMM';
      const extra = pool.extraData || {};
      const tickSpacing = extra.tickSpacing || 1;
      const tickCurrent = extra.tickCurrent;
      if (tickCurrent !== undefined) {
        if (!extra.tickArrays) extra.tickArrays = {};
        const surrounding = isClmm
          ? getSurroundingRaydiumClmmTickArrayStartIndices(tickCurrent, tickSpacing)
          : getSurroundingTickArrayStartIndices(tickCurrent, tickSpacing);
        for (const startIdx of surrounding) {
          const pda = isClmm ? deriveRaydiumClmmTickArrayPda(pool.id, startIdx) : deriveTickArrayPda(pool.id, startIdx);
          tickArraysToFetch.push({ pda, poolIndex: pIdx, startIdx, isClmm });
        }
      }
    }
  }

  console.log(`Fetching ${tickArraysToFetch.length} tick arrays via RPC...`);
  const tRes = await rpc.getMultipleAccountsAndContext(tickArraysToFetch.map(t => t.pda));
  for (let i = 0; i < tickArraysToFetch.length; i++) {
    const item = tickArraysToFetch[i];
    const acc = tRes.value[i];
    const pool = decodedPools[item.poolIndex];
    if (!pool || !acc || !acc.data) continue;
    const extra = pool.extraData || {};
    if (!extra.tickArrays) extra.tickArrays = {};
    if (!extra.tickArraySlots) extra.tickArraySlots = {};
    if (!extra.tickArrayReceivedAt) extra.tickArrayReceivedAt = {};

    extra.tickArrays[item.startIdx] = true;
    extra.tickArraySlots[item.startIdx] = tRes.slot;
    extra.tickArrayReceivedAt[item.startIdx] = Date.now();
  }

  let verifiedCount = 0;
  const verifiedList: string[] = [];
  const unverifiedList: Array<{ id: string; dex: string; reason: string }> = [];

  for (const pool of decodedPools) {
    let isVerified = false;
    let reason = 'UNVERIFIED';

    if (pool.dex === 'RAYDIUM_AMM') {
      const extra = pool.extraData || {};
      const hasReserves = (pool.reserveA ?? 0n) > 0n && (pool.reserveB ?? 0n) > 0n;
      const ooOk = extra.openOrdersVerified === true;
      if (hasReserves && ooOk) {
        isVerified = true;
      } else {
        reason = !hasReserves ? 'VAULT_RESERVES_UNHYDRATED' : 'OPENORDERS_UNVERIFIED';
      }
    } else if (pool.dex === 'ORCA_WHIRLPOOL' || pool.dex === 'RAYDIUM_CLMM') {
      const isClmm = pool.dex === 'RAYDIUM_CLMM';
      const extra = pool.extraData || {};
      const tickCurrent = extra.tickCurrent;
      const tickSpacing = extra.tickSpacing || 1;
      const surrounding = isClmm
        ? getSurroundingRaydiumClmmTickArrayStartIndices(tickCurrent, tickSpacing)
        : getSurroundingTickArrayStartIndices(tickCurrent, tickSpacing);
      const currentStart = surrounding[2];

      const currentPresent = extra.tickArrays && extra.tickArrays[currentStart] === true;
      if (currentPresent) {
        isVerified = true;
      } else {
        reason = 'MISSING_CURRENT_TICK_ARRAY';
      }
    } else {
      reason = `UNSUPPORTED_DEX (${pool.dex})`;
    }

    if (isVerified) {
      verifiedCount++;
      verifiedList.push(`${pool.id} [${pool.dex}]`);
    } else {
      unverifiedList.push({ id: pool.id, dex: pool.dex, reason });
    }
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Total verified: ${verifiedCount} / ${decodedPools.length}`);
  console.log(`Total unverified: ${unverifiedList.length} / ${decodedPools.length}`);

  const reasonsCount: Record<string, number> = {};
  for (const u of unverifiedList) {
    reasonsCount[u.reason] = (reasonsCount[u.reason] || 0) + 1;
  }
  console.log('Unverified reasons breakdown:', reasonsCount);
  console.log('\nUnverified pools:');
  for (const u of unverifiedList) {
    console.log(`  ${u.id} [${u.dex}] -> ${u.reason}`);
  }
}

main().catch(console.error);
