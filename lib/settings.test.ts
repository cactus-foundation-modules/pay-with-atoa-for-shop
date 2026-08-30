import { describe, expect, it } from 'vitest'
import {
  MAX_EXPIRES_IN_MINUTES, MAX_PAYMENT_DESCRIPTION_LENGTH, MIN_EXPIRES_IN_MINUTES,
  clampExpiresInMinutes, clampPaymentDescription, toPaymentEntry,
} from '@/modules/pay-with-atoa-for-shop/lib/settings'

describe('clampExpiresInMinutes', () => {
  // Atoa accepts expiresIn values of 0 and -1 without complaint, so a link that
  // is dead on arrival is a thing an owner could type their way into.
  it('pulls a nonsensical expiry back into range', () => {
    expect(clampExpiresInMinutes(0)).toBe(MIN_EXPIRES_IN_MINUTES)
    expect(clampExpiresInMinutes(-1)).toBe(MIN_EXPIRES_IN_MINUTES)
    expect(clampExpiresInMinutes(99999)).toBe(MAX_EXPIRES_IN_MINUTES)
  })

  it('leaves a sensible expiry alone', () => {
    expect(clampExpiresInMinutes(30)).toBe(30)
    expect(clampExpiresInMinutes('45')).toBe(45)
  })

  // Number(null) is 0, which is perfectly finite - so a missing value that fell
  // through to the clamp would hand the shop the FLOOR rather than the default.
  it('falls back rather than clamping a missing value to the floor', () => {
    expect(clampExpiresInMinutes('nonsense')).toBe(30)
    expect(clampExpiresInMinutes(null)).toBe(30)
    expect(clampExpiresInMinutes(undefined)).toBe(30)
    expect(clampExpiresInMinutes('')).toBe(30)
    expect(clampExpiresInMinutes(true)).toBe(30)
  })
})

describe('clampPaymentDescription', () => {
  // Atoa rejects a payment note over 30 characters outright, with a 400.
  it('cuts a description to the length Atoa will accept', () => {
    const long = 'x'.repeat(60)
    expect(clampPaymentDescription(long)).toHaveLength(MAX_PAYMENT_DESCRIPTION_LENGTH)
  })

  it('trims and tolerates anything that is not a string', () => {
    expect(clampPaymentDescription('  Corner Shop  ')).toBe('Corner Shop')
    expect(clampPaymentDescription(null)).toBe('')
    expect(clampPaymentDescription(7)).toBe('')
  })
})

describe('toPaymentEntry', () => {
  it('keeps either of the two real choices', () => {
    expect(toPaymentEntry('redirect')).toBe('redirect')
    expect(toPaymentEntry('on-page')).toBe('on-page')
  })

  // A row written before 002_payment_entry.sql existed reads NULL here, and a
  // value from a later version of this module reads as something this one has
  // never heard of. Both must land on the redirect, which needs nothing of
  // anybody - the on-page dialog only opens on a domain whitelisted in the Atoa
  // dashboard, so defaulting to it would switch a working payment method off on
  // a live shop the moment the module updated.
  it('reads anything else as the hosted redirect', () => {
    expect(toPaymentEntry(null)).toBe('redirect')
    expect(toPaymentEntry(undefined)).toBe('redirect')
    expect(toPaymentEntry('onpage')).toBe('redirect')
    expect(toPaymentEntry('ON-PAGE')).toBe('redirect')
    expect(toPaymentEntry(true)).toBe('redirect')
    expect(toPaymentEntry({ paymentEntry: 'on-page' })).toBe('redirect')
  })
})
