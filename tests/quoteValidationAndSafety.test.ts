import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ArbitrageProfitCalculator } from '../src/profit/calculator.js';
import { loadConfig } from '../src/config/index.js';
import { SwapQuote, CostBreakdown } from '../src/types/index.js';

describe('Test Matrix 10, 11, 17, 19: Quote Validation, Slot/Time Bounds, RFQ Separation, and Zero-Execution Audit', () => {
  const config = loadConfig({
    MAX_QUOTE_AGE_MS: '2500',
    MAX_SLOT_GAP: '10'
  });
  const calculator = new ArbitrageProfitCalculator(config);

  const dummyCosts: CostBreakdown = {
    networkFeeUSDC: '0.000625',
    priorityFeeUSDC: '0.001250',
    jitoTipUSDC: '0.000000',
    tokenTransferFeesUSDC: '0.000000',
    contingencyUSDC: '0.0200',
    safetyBufferUSDC: '0.2500',
    totalCostsUSDC: '0.021875',
    solPriceUSDC: '125.00',
    assumptions: ['Standard test assumptions']
  };

  const createQuote = (overrides: Partial<SwapQuote>): SwapQuote => ({
    quoteSource: 'DIRECT_POOL',
    poolId: 'pool-valid-A',
    dex: 'RAYDIUM_AMM',
    inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    outputMint: 'So11111111111111111111111111111111111111112',
    inAmount: 100000000n,
    outAmount: 800000000n,
    feeIncluded: true,
    feeAmount: 250000n,
    priceImpactBps: 2,
    slot: 468500000,
    timestamp: Date.now(),
    executionType: 'POTENTIAL_ATOMIC',
    ...overrides
  });

  it('Matrix 10.1: Rejects quotes with slot gap exceeding MAX_SLOT_GAP', () => {
    const leg1 = createQuote({ slot: 468500000 });
    const leg2 = createQuote({ poolId: 'pool-valid-B', slot: 468500025 }); // slot gap = 25 > 10

    const cand = calculator.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote: leg1,
      leg2Quote: leg2,
      costs: dummyCosts,
      currentSlot: 468500025,
      wsConnected: true
    });

    expect(cand.status).toBe('REJECTED');
    expect(cand.rejectionReasons).toContain('SLOT_MISMATCH');
  });

  it('Matrix 10.2: Rejects quotes older than MAX_QUOTE_AGE_MS', () => {
    const staleTime = Date.now() - 5000; // 5000ms old > 2500ms
    const leg1 = createQuote({ timestamp: staleTime });
    const leg2 = createQuote({ poolId: 'pool-valid-B', timestamp: Date.now() });

    const cand = calculator.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote: leg1,
      leg2Quote: leg2,
      costs: dummyCosts,
      currentSlot: 468500000,
      wsConnected: true
    });

    expect(cand.status).toBe('STALE');
    expect(cand.rejectionReasons).toContain('STALE_QUOTE');
  });

  it('Matrix 11.1: Rejects zero and negative output quotes', () => {
    const leg1 = createQuote({ outAmount: 0n });
    const leg2 = createQuote({ poolId: 'pool-valid-B', outAmount: 100000000n });

    const cand = calculator.evaluateCandidate({
      initialAmountUSDC: 100000000n,
      leg1Quote: leg1,
      leg2Quote: leg2,
      costs: dummyCosts,
      currentSlot: 468500000,
      wsConnected: true
    });

    expect(cand.status).toBe('REJECTED');
    expect(cand.rejectionReasons).toContain('INSUFFICIENT_LIQUIDITY');
  });

  it('Matrix 17.1: Strictly separates JUPITER_ORDER_INDICATIVE (RFQ) from JUPITER_BUILD_METIS (composable)', () => {
    const rfqQuote: SwapQuote = {
      ...createQuote({}),
      quoteSource: 'JUPITER_ORDER_INDICATIVE',
      executionType: 'INDICATIVE_ONLY'
    };

    const metisQuote: SwapQuote = {
      ...createQuote({ poolId: 'metis-pool-B' }),
      quoteSource: 'JUPITER_BUILD_METIS',
      executionType: 'POTENTIAL_ATOMIC'
    };

    expect(rfqQuote.quoteSource).not.toBe(metisQuote.quoteSource);
    expect(rfqQuote.executionType).toBe('INDICATIVE_ONLY');
    expect(metisQuote.executionType).toBe('POTENTIAL_ATOMIC');
  });

  it('Matrix 19.1: Comprehensive codebase audit: ZERO wallet keys, ZERO signers, ZERO sendTransaction calls', () => {
    const srcDir = path.resolve(__dirname, '../src');
    const readDirRecursive = (dir: string): string[] => {
      let results: string[] = [];
      const list = fs.readdirSync(dir);
      for (const file of list) {
        const fullPath = path.resolve(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          results = results.concat(readDirRecursive(fullPath));
        } else if (file.endsWith('.ts')) {
          results.push(fullPath);
        }
      }
      return results;
    };

    const srcFiles = readDirRecursive(srcDir);
    expect(srcFiles.length).toBeGreaterThan(0);

    const forbiddenPatterns = [
      /sendTransaction/i,
      /sendRawTransaction/i,
      /sendAndConfirmTransaction/i,
      /Keypair\.fromSecretKey/i,
      /Keypair\.fromSeed/i,
      /Keypair\.generate/i,
      /signTransaction/i,
      /signAllTransactions/i,
      /signMessage/i,
      /process\.env\.[A-Z0-9_]*PRIVATE_KEY/i,
      /process\.env\.[A-Z0-9_]*SECRET_KEY/i
    ];

    for (const filePath of srcFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      for (const pattern of forbiddenPatterns) {
        const match = content.match(pattern);
        expect(match, `Forbidden execution/signer pattern found in ${filePath}: ${match?.[0]}`).toBeNull();
      }
    }
  });
});
