import { describe, expect, it } from 'vitest'
import { atoaPaymentIntent } from '@/modules/pay-with-atoa-for-shop/lib/intent'

const created = { paymentRequestId: 'pr_123', paymentUrl: 'https://atoa.me/pay?paymentRequestId=pr_123' }

describe('atoaPaymentIntent', () => {
  it('hands the shopper over in redirect mode', () => {
    const intent = atoaPaymentIntent('redirect', created)
    expect(intent.approvalUrl).toBe(created.paymentUrl)
    expect(intent.providerOrderId).toBe('pr_123')
  })

  it('feeds the on-page fields in on-page mode', () => {
    const intent = atoaPaymentIntent('on-page', created)
    expect(intent.clientFields).toEqual({ paymentRequestId: 'pr_123' })
    expect(intent.providerOrderId).toBe('pr_123')
  })

  // The whole reason this function exists. Shop checks for approvalUrl first
  // and redirects on it, so an intent carrying both would send the shopper away
  // from fields it had just drawn for them.
  it('never returns both an approvalUrl and clientFields', () => {
    expect(atoaPaymentIntent('redirect', created).clientFields).toBeUndefined()
    expect(atoaPaymentIntent('on-page', created).approvalUrl).toBeUndefined()
  })
})
