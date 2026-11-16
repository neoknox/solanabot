import { loadConfig } from '../src/config/index.js';
import { SolanaRpcProvider } from '../src/providers/solanaRpc.js';
import { PublicKey } from '@solana/web3.js';
import { dexRegistry } from '../src/dex/index.js';
import { TradeSizer, QuoterLeg } from '../src/profit/tradeSizer.js';
import { CostModel } from '../src/profit/costModel.js';
import { deriveTickArrayPda, getSurroundingTickArrayStartIndices, decodeTickArrayAccount } from '../src/dex/orcaTickArray.js';
import { CANONICAL_WSOL_MINT, CANONICAL_USDC_MINT } from '../src/config/index.js';
import Decimal from 'decimal.js';

async function main() {
  const config = loadConfig();
  const rpc = new SolanaRpcProvider(config);
  const tradeSizer = new TradeSizer(config);
  const costModel = new CostModel(config);

  const orcaPoolId = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
  const raydiumPoolId = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';

  console.log('Fetching on-chain states for Orca Whirlpool and Raydium AMM...');
  const poolRes = await rpc.getMultipleAccountsAndContext([new PublicKey(orcaPoolId), new PublicKey(raydiumPoolId)]);
  const slot = poolRes.slot;
  const orcaAcc = poolRes.value[0]!;
  const rayAcc = poolRes.value[1]!;

  const orcaAdapter = dexRegistry.getAdapter('ORCA_WHIRLPOOL')!;
  const rayAdapter = dexRegistry.getAdapter('RAYDIUM_AMM')!;

  const orcaState = orcaAdapter.decodePoolState(orcaAcc.data, orcaPoolId, slot)!;
  const rayState = rayAdapter.decodePoolState(rayAcc.data, raydiumPoolId, slot)!;

  // Hydrate Raydium Vaults and OpenOrders
  const rayExtra = rayState.extraData as any;
  const vA = new PublicKey(rayExtra.baseVault);
  const vB = new PublicKey(rayExtra.quoteVault);
  const oo = new PublicKey(rayExtra.openOrders);

  const rayDepRes = await rpc.getMultipleAccountsAndContext([vA, vB, oo]);
  rayState.reserveA = rayDepRes.value[0]!.data.readBigUInt64LE(64);
  rayState.reserveB = rayDepRes.value[1]!.data.readBigUInt64LE(64);
  rayExtra.openOrdersVerified = true;
  rayExtra.openOrdersBaseTokenTotal = rayDepRes.value[2]!.data.readBigUInt64LE(85).toString();
  rayExtra.openOrdersQuoteTokenTotal = rayDepRes.value[2]!.data.readBigUInt64LE(101).toString();
  rayState.receivedAt = Date.now();
  rayState.slot = rayDepRes.slot;

  console.log(`Raydium AMM Hydrated: reserveA=${rayState.reserveA}, reserveB=${rayState.reserveB}`);

  // Hydrate Orca Tick Arrays
  const orcaExtra = orcaState.extraData as any;
  const tickCurrent = orcaExtra.tickCurrent;
  const tickSpacing = orcaExtra.tickSpacing || 1;
  const surrounding = getSurroundingTickArrayStartIndices(tickCurrent, tickSpacing);

  const tickPdas = surrounding.map(startIdx => deriveTickArrayPda(orcaPoolId, startIdx));
  const tickRes = await rpc.getMultipleAccountsAndContext(tickPdas);

  orcaExtra.tickArrays = {};
  orcaExtra.tickArraySlots = {};
  orcaExtra.tickArrayReceivedAt = {};
  for (let i = 0; i < surrounding.length; i++) {
    const acc = tickRes.value[i];
    if (acc && acc.data) {
      const decodedArr = decodeTickArrayAccount(acc.data, orcaPoolId);
      if (decodedArr) {
        orcaExtra.tickArrays[surrounding[i]] = decodedArr;
        orcaExtra.tickArraySlots[surrounding[i]] = tickRes.slot;
        orcaExtra.tickArrayReceivedAt[surrounding[i]] = Date.now();
      }
    }
  }
  orcaState.receivedAt = Date.now();
  orcaState.slot = tickRes.slot;
  console.log(`Orca Whirlpool Hydrated: tickCurrent=${tickCurrent}, tickArrays=${Object.keys(orcaExtra.tickArrays).length}`);

  const costs = costModel.calculateCosts({
    solPriceUSDC: new Decimal(140),
    solPriceTimestamp: Date.now(),
    requiresAtaSetup: false
  });
  console.log('Cost calculation result:', costs);

  // Direction 1: USDC -> SOL on Orca Whirlpool, SOL -> USDC on Raydium AMM
  const legs1: QuoterLeg[] = [
    { pool: orcaState, adapter: orcaAdapter, inputMint: CANONICAL_USDC_MINT, outputMint: CANONICAL_WSOL_MINT, slippageBps: 10 },
    { pool: rayState, adapter: rayAdapter, inputMint: CANONICAL_WSOL_MINT, outputMint: CANONICAL_USDC_MINT, slippageBps: 10 }
  ];

  console.log('\n--- QUOTING DIRECTION 1: Orca -> Raydium ---');
  const sizerRes1 = tradeSizer.findOptimalSize(legs1, costs.breakdown!, slot);
  console.log(`Optimal Size USDC:          $${sizerRes1.optimalSizeUSDC}`);
  console.log(`sizerRes1 keys:`, Object.keys(sizerRes1));
  console.log(`sizerRes1:`, sizerRes1);

  // Direction 2: USDC -> SOL on Raydium AMM, SOL -> USDC on Orca Whirlpool
  const legs2: QuoterLeg[] = [
    { pool: rayState, adapter: rayAdapter, inputMint: CANONICAL_USDC_MINT, outputMint: CANONICAL_WSOL_MINT, slippageBps: 10 },
    { pool: orcaState, adapter: orcaAdapter, inputMint: CANONICAL_WSOL_MINT, outputMint: CANONICAL_USDC_MINT, slippageBps: 10 }
  ];

  console.log('\n--- QUOTING DIRECTION 2: Raydium -> Orca ---');
  const sizerRes2 = tradeSizer.findOptimalSize(legs2, costs.breakdown!, slot);
  console.log(`Optimal Size USDC:          $${sizerRes2.optimalSizeUSDC}`);
  console.log(`Valid:                      ${sizerRes2.optimalResult !== null}`);
  if (sizerRes2.optimalResult) {
    const r = sizerRes2.optimalResult;
    console.log(`Expected Net USDC:          $${r.expectedNetUSDC.toString()}`);
    console.log(`Min Conservative Net USDC:  $${r.conservativeNetUSDC.toString()}`);
    console.log(`Final Expected Units:       ${r.finalExpectedUnits}`);
  } else {
    console.log(`Primary rejection code:     ${sizerRes2.primaryRejectionCode}`);
  }
}

main().catch(console.error);
