import Decimal from 'decimal.js';

// Orca sqrtPrice Q64.64
// Suppose tickCurrent is around -26436
// tickCurrent is log_1.0001(price)
// price = 1.0001^(-26436) = ~0.07109
// 0.07109 SOL per USDC = 1 / 0.07109 = 140.66 USDC per SOL!
const tickCurrent = -26436;
const rawPrice = Math.pow(1.0001, tickCurrent);
console.log('rawPrice (WSOL per USDC raw):', rawPrice);
// 1 USDC (1e6) = rawPrice * 1e9 lamports = rawPrice * 1000 SOL.
// So 1 USDC = 0.07109 * 1000 = 71.09 SOL? Wait! 
// If SOL is $140, 1 SOL = 140 USDC. 
// So 1 USDC = 1/140 = 0.00714 SOL = 7,140,000 lamports.
// 7,140,000 lamports / 1,000,000 USDC units = 7.14.
// If tickCurrent = -26436:
// 1.0001^(-26436) = 0.07109.
// If Token A is USDC (6) and Token B is WSOL (9):
// In Uniswap v3 / Whirlpool:
// price = token1 / token0 = WSOL_raw / USDC_raw.
// So 1 unit of USDC (10^-6) buys rawPrice units of WSOL (10^-9).
// rawPrice = (WSOL_amount * 10^9) / (USDC_amount * 10^6) = (WSOL / USDC) * 10^3.
// WSOL / USDC = rawPrice / 1000.
// USDC / WSOL (Price of 1 SOL in USDC) = 1000 / rawPrice = 1000 / (ratio * ratio)!
console.log('Price of SOL in USDC:', 1000 / (rawPrice * 1000));
console.log('1 / (rawPrice / 1000):', 1 / (rawPrice / 1000));
