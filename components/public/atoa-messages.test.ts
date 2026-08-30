import { describe, expect, it } from 'vitest'
import {
  ATOA_MESSAGES, atoaClientOutcome, atoaCloseMessage,
} from '@/modules/pay-with-atoa-for-shop/components/public/atoa-messages'

describe('atoaClientOutcome', () => {
  it('settles only on a completed payment', () => {
    expect(atoaClientOutcome('COMPLETED')).toBe('settled')
  })

  it('reads a failed payment as failed', () => {
    expect(atoaClientOutcome('FAILED')).toBe('failed')
  })

  // The one that would confirm an order for somebody who has not paid: Atoa's
  // SDK-side payment details answer PENDING for a payment request nobody has
  // touched (proved in sandbox on a freshly created request, where the merchant
  // status endpoint said PAYMENT_NOT_INITIATED).
  it('keeps waiting on PENDING rather than treating it as paid', () => {
    expect(atoaClientOutcome('PENDING')).toBe('waiting')
  })

  it('keeps waiting on anything it has never heard of', () => {
    expect(atoaClientOutcome('SOMETHING_NEW')).toBe('waiting')
    expect(atoaClientOutcome(undefined)).toBe('waiting')
    expect(atoaClientOutcome(null)).toBe('waiting')
    expect(atoaClientOutcome(7)).toBe('waiting')
  })
})

describe('atoaCloseMessage', () => {
  it('says the payment failed when that is what happened', () => {
    expect(atoaCloseMessage('FAILED')).toBe(ATOA_MESSAGES.failed)
  })

  it('treats a close with nothing terminal in it as a shopper changing their mind', () => {
    expect(atoaCloseMessage(undefined)).toBe(ATOA_MESSAGES.closed)
    expect(atoaCloseMessage('PENDING')).toBe(ATOA_MESSAGES.closed)
  })
})

describe('the messages themselves', () => {
  // They go straight onto the checkout's error line, so a status code or a
  // bracketed SDK prefix reaching one of them is a shopper-facing defect.
  it('are sentences a shopper can read', () => {
    for (const message of Object.values(ATOA_MESSAGES)) {
      expect(message).toMatch(/^[A-Z].*[.!]$/)
      expect(message).not.toMatch(/[A-Z]{4,}_[A-Z]/)
      expect(message).not.toContain('[')
    }
  })
})
