import { describe, expect, it } from 'vitest'
import {
  UnknownAtoaStatusError, atoaSettlementOutcome, parseAtoaPaymentStatus, parseAtoaRefundStatus,
} from '@/modules/pay-with-atoa-for-shop/lib/status'

describe('parseAtoaPaymentStatus', () => {
  // The one that matters most: PAYMENT_NOT_INITIATED arrives with a perfectly
  // happy HTTP 200 and is the commonest status Atoa has - every shopper who
  // reaches the checkout and then does not pay. A mapper that threw on it would
  // throw on the normal case.
  it('recognises PAYMENT_NOT_INITIATED', () => {
    expect(parseAtoaPaymentStatus('PAYMENT_NOT_INITIATED')).toBe('PAYMENT_NOT_INITIATED')
    expect(atoaSettlementOutcome('PAYMENT_NOT_INITIATED')).toBe('not-started')
  })

  it('recognises every status it is meant to', () => {
    for (const status of ['PENDING', 'AUTHORIZED', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'] as const) {
      expect(parseAtoaPaymentStatus(status)).toBe(status)
    }
  })

  it('throws on anything else rather than picking a least-worst meaning', () => {
    expect(() => parseAtoaPaymentStatus('SOMETHING_NEW')).toThrow(UnknownAtoaStatusError)
    expect(() => parseAtoaPaymentStatus('completed')).toThrow(UnknownAtoaStatusError)
    expect(() => parseAtoaPaymentStatus(undefined)).toThrow(UnknownAtoaStatusError)
    expect(() => parseAtoaPaymentStatus(null)).toThrow(UnknownAtoaStatusError)
    expect(() => parseAtoaPaymentStatus(42)).toThrow(UnknownAtoaStatusError)
  })
})

describe('atoaSettlementOutcome', () => {
  it('only COMPLETED means the money is in', () => {
    expect(atoaSettlementOutcome('COMPLETED')).toBe('paid')
  })

  it('treats the in-flight and card-capture states as pending', () => {
    expect(atoaSettlementOutcome('PENDING')).toBe('pending')
    expect(atoaSettlementOutcome('AUTHORIZED')).toBe('pending')
  })

  it('treats a cancelled or expired request as a failure, not as nothing', () => {
    expect(atoaSettlementOutcome('FAILED')).toBe('failed')
    expect(atoaSettlementOutcome('CANCELLED')).toBe('failed')
    expect(atoaSettlementOutcome('EXPIRED')).toBe('failed')
  })
})

describe('parseAtoaRefundStatus', () => {
  it('recognises the three documented refund statuses', () => {
    for (const status of ['INITIATED', 'COMPLETED', 'FAILED'] as const) {
      expect(parseAtoaRefundStatus(status)).toBe(status)
    }
  })

  it('throws on anything else', () => {
    expect(() => parseAtoaRefundStatus('REFUNDED')).toThrow(UnknownAtoaStatusError)
    expect(() => parseAtoaRefundStatus(null)).toThrow(UnknownAtoaStatusError)
  })
})
