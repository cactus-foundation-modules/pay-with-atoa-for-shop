import { createHmac, randomBytes } from 'crypto'
import { describe, expect, it } from 'vitest'
import { atoaSignatureDigest, atoaSigningKey, verifyAtoaWebhookSignature } from '@/modules/pay-with-atoa-for-shop/lib/webhook-signature'

// Atoa's signing secret is `whsec_<base64>`, and the base64 half decodes to the
// 32 raw bytes that are the HMAC key. Using the `whsec_...` string itself as the
// key produces a digest that never matches - which on a payment route means
// every genuine webhook rejected, and orders sitting at "awaiting confirmation"
// for ever with the shopper's money gone.

const KEY = randomBytes(32)
const SECRET = `whsec_${KEY.toString('base64')}`
const BODY = '{"eventType":"PAYMENTS_STATUS","paymentRequestId":"abc","status":"COMPLETED"}'

function sign(body: string, key: Buffer): string {
  return `v1=${createHmac('sha256', key).update(body, 'utf8').digest('hex')}`
}

describe('atoaSigningKey', () => {
  it('strips whsec_ and base64-decodes the rest', () => {
    expect(atoaSigningKey(SECRET)?.equals(KEY)).toBe(true)
  })

  it('refuses a secret that is not in Atoa\'s shape', () => {
    expect(atoaSigningKey(KEY.toString('base64'))).toBeNull()
    expect(atoaSigningKey('whsec_')).toBeNull()
    expect(atoaSigningKey('')).toBeNull()
  })
})

describe('atoaSignatureDigest', () => {
  it('strips the v1= scheme prefix', () => {
    expect(atoaSignatureDigest('v1=abcdef01')).toBe('abcdef01')
    expect(atoaSignatureDigest('  v1=ABCDEF01  ')).toBe('abcdef01')
  })

  it('refuses a header that is not a hex digest under a known scheme', () => {
    expect(atoaSignatureDigest('abcdef01')).toBeNull()
    expect(atoaSignatureDigest('v2=abcdef01')).toBeNull()
    expect(atoaSignatureDigest('v1=not-hex')).toBeNull()
  })
})

describe('verifyAtoaWebhookSignature', () => {
  it('accepts a signature made with the decoded key', () => {
    expect(verifyAtoaWebhookSignature({ rawBody: BODY, header: sign(BODY, KEY), secret: SECRET })).toBe(true)
  })

  // The exact mistake that would reject every real webhook.
  it('rejects a signature made with the whsec_ string as the key', () => {
    const wrong = `v1=${createHmac('sha256', SECRET).update(BODY, 'utf8').digest('hex')}`
    expect(verifyAtoaWebhookSignature({ rawBody: BODY, header: wrong, secret: SECRET })).toBe(false)
  })

  it('rejects a body that has been re-serialised', () => {
    const header = sign(BODY, KEY)
    const reserialised = JSON.stringify(JSON.parse(BODY), null, 2)
    expect(verifyAtoaWebhookSignature({ rawBody: reserialised, header, secret: SECRET })).toBe(false)
  })

  it('rejects a signature made with somebody else\'s key', () => {
    expect(verifyAtoaWebhookSignature({ rawBody: BODY, header: sign(BODY, randomBytes(32)), secret: SECRET })).toBe(false)
  })

  it('rejects a missing header or a missing secret', () => {
    expect(verifyAtoaWebhookSignature({ rawBody: BODY, header: null, secret: SECRET })).toBe(false)
    expect(verifyAtoaWebhookSignature({ rawBody: BODY, header: sign(BODY, KEY), secret: null })).toBe(false)
  })

  it('rejects a digest of the wrong length rather than throwing on it', () => {
    expect(verifyAtoaWebhookSignature({ rawBody: BODY, header: 'v1=abcd', secret: SECRET })).toBe(false)
  })

  it('rejects a header carrying an unknown signing scheme', () => {
    const digest = createHmac('sha256', KEY).update(BODY, 'utf8').digest('hex')
    expect(verifyAtoaWebhookSignature({ rawBody: BODY, header: `v2=${digest}`, secret: SECRET })).toBe(false)
  })

  it('tolerates a bare hex digest with no scheme prefix', () => {
    const digest = createHmac('sha256', KEY).update(BODY, 'utf8').digest('hex')
    expect(verifyAtoaWebhookSignature({ rawBody: BODY, header: digest, secret: SECRET })).toBe(true)
  })
})
