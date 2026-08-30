import { describe, expect, it } from 'vitest'
import { paymentMatchesOrder } from '@/modules/pay-with-atoa-for-shop/lib/settle'

// The check that was missing from the settlement path most payments actually
// take, in the two modules this one is modelled on. A payment can only fulfil an
// order if it is for that order's money.

describe('paymentMatchesOrder', () => {
  it('accepts the right money in the right currency', () => {
    expect(paymentMatchesOrder({ paidAmount: 484, currency: 'GBP' }, { total: '484.00', currency: 'GBP' })).toBe(true)
  })

  it('takes the decimal strings the order layer hands it', () => {
    expect(paymentMatchesOrder({ paidAmount: 1600, currency: 'GBP' }, { total: '1600.00', currency: 'GBP' })).toBe(true)
    expect(paymentMatchesOrder({ paidAmount: 4, currency: 'GBP' }, { total: 4, currency: 'GBP' })).toBe(true)
  })

  it('refuses an underpayment', () => {
    expect(paymentMatchesOrder({ paidAmount: 1, currency: 'GBP' }, { total: '484.00', currency: 'GBP' })).toBe(false)
  })

  it('refuses an overpayment too - it is still not this order', () => {
    expect(paymentMatchesOrder({ paidAmount: 999.99, currency: 'GBP' }, { total: '484.00', currency: 'GBP' })).toBe(false)
  })

  it('refuses a penny out', () => {
    expect(paymentMatchesOrder({ paidAmount: 483.99, currency: 'GBP' }, { total: '484.00', currency: 'GBP' })).toBe(false)
  })

  it('refuses the right number in the wrong currency', () => {
    expect(paymentMatchesOrder({ paidAmount: 484, currency: 'EUR' }, { total: '484.00', currency: 'GBP' })).toBe(false)
  })

  it('is not fussy about the case of a currency code', () => {
    expect(paymentMatchesOrder({ paidAmount: 484, currency: 'gbp' }, { total: '484.00', currency: 'GBP' })).toBe(true)
  })

  it('refuses an order whose total cannot be read as money', () => {
    expect(paymentMatchesOrder({ paidAmount: 484, currency: 'GBP' }, { total: null, currency: 'GBP' })).toBe(false)
    expect(paymentMatchesOrder({ paidAmount: 484, currency: 'GBP' }, { total: 'nonsense', currency: 'GBP' })).toBe(false)
  })

  // Atoa omits the amount entirely until somebody has paid. "We could not see
  // what was paid" must never read as "the right amount was paid".
  it('refuses a payment that reports no amount at all', () => {
    expect(paymentMatchesOrder({ paidAmount: null, currency: 'GBP' }, { total: '484.00', currency: 'GBP' })).toBe(false)
  })

  // Both sides are compared in whole pence: 19.99 as a float is not 19.99.
  it('compares in pence rather than in floats', () => {
    expect(paymentMatchesOrder({ paidAmount: 19.99, currency: 'GBP' }, { total: '19.99', currency: 'GBP' })).toBe(true)
    expect(paymentMatchesOrder({ paidAmount: 0.07, currency: 'GBP' }, { total: '0.07', currency: 'GBP' })).toBe(true)
    expect(paymentMatchesOrder({ paidAmount: 1234.56, currency: 'GBP' }, { total: '1234.56', currency: 'GBP' })).toBe(true)
  })
})
