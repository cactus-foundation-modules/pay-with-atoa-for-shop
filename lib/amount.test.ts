import { describe, expect, it } from 'vitest'
import { ATOA_MINIMUM_AMOUNT, isAtoaCurrency, isBelowAtoaMinimum, roundToPennies, toPence } from '@/modules/pay-with-atoa-for-shop/lib/amount'

// Atoa's amount is in MAJOR units, and it TRUNCATES a third decimal place
// rather than rounding it - 12.999 was rendered by Atoa itself as £12.99. Both
// facts were proved in sandbox, and both would cost real money if wrong.

describe('roundToPennies', () => {
  it('leaves a two-decimal amount alone', () => {
    expect(roundToPennies(12.34)).toBe(12.34)
    expect(roundToPennies(1234)).toBe(1234)
  })

  it('rounds a third decimal place rather than letting Atoa truncate it', () => {
    expect(roundToPennies(12.999)).toBe(13)
    expect(roundToPennies(12.345)).toBe(12.35)
    expect(roundToPennies(12.344)).toBe(12.34)
    // Half-up on the decimal anybody wrote down, not on its binary shadow.
    expect(roundToPennies(1.005)).toBe(1.01)
  })

  it('clears float dust', () => {
    expect(roundToPennies(0.1 + 0.2)).toBe(0.3)
    expect(roundToPennies(19.99 * 3)).toBe(59.97)
  })
})

describe('toPence', () => {
  it('turns major units into whole pence', () => {
    expect(toPence(19.99)).toBe(1999)
    expect(toPence(0.07)).toBe(7)
    expect(toPence(1600)).toBe(160000)
  })

  // 1.005 * 100 is 100.49999999999999 in binary. A bare Math.round would give
  // 100 and shave off the very penny the truncation guard exists to protect.
  it('does not lose a penny to float representation', () => {
    expect(toPence(1.005)).toBe(101)
    expect(toPence(1234.56)).toBe(123456)
    expect(toPence(8.615)).toBe(862)
  })
})

describe('isBelowAtoaMinimum', () => {
  it('refuses anything under a pound, which Atoa rejects outright', () => {
    expect(isBelowAtoaMinimum(0.01)).toBe(true)
    expect(isBelowAtoaMinimum(0.99)).toBe(true)
    expect(isBelowAtoaMinimum(0.999)).toBe(false) // rounds up to £1.00
  })

  it('accepts the floor itself and anything above it', () => {
    expect(isBelowAtoaMinimum(ATOA_MINIMUM_AMOUNT)).toBe(false)
    expect(isBelowAtoaMinimum(484)).toBe(false)
  })
})

describe('isAtoaCurrency', () => {
  it('accepts pounds however they are spelled', () => {
    expect(isAtoaCurrency('GBP')).toBe(true)
    expect(isAtoaCurrency(' gbp ')).toBe(true)
  })

  // Atoa accepts a currency field on create and ignores it completely - USD,
  // EUR and a made-up code all rendered as pounds - so this is the only thing
  // stopping a euro order being charged the same number in sterling.
  it('refuses everything else', () => {
    expect(isAtoaCurrency('EUR')).toBe(false)
    expect(isAtoaCurrency('USD')).toBe(false)
    expect(isAtoaCurrency('')).toBe(false)
  })
})
