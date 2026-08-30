// Verifying that a webhook really came from Atoa.
//
// Three details here, and getting any one of them wrong rejects every genuine
// webhook - which on a payment route means orders sitting at "awaiting
// confirmation" for ever with the shopper's money gone:
//
//  1. The signing secret is NOT the HMAC key. Atoa's dashboard hands out
//     `whsec_<base64>`; the key is the base64 payload decoded to its raw bytes
//     (32 of them, a 256-bit key). Using the `whsec_...` string as the key
//     produces a digest that never matches.
//  2. The header value carries a scheme prefix: `X-Atoa-Signature: v1=<hex>`,
//     not a bare digest.
//  3. The body must be the RAW request body, read with request.text() before
//     anything parses it. A re-serialised body will not match.
//
// This is V2 signing, which a merchant turns on in the Atoa dashboard and which
// is what produces the `whsec_` secret in the first place. V1 signing - a
// `signatureHash` field inside the JSON body, covering only orderId and
// paymentRequestId - is deliberately NOT supported: it signs two non-secret
// identifiers, which is close to no protection at all, and supporting both
// would double the surface on a money route. A shop with no V2 secret does not
// offer the method (see isAtoaConfigured).
import { createHmac, timingSafeEqual } from 'crypto'

export const ATOA_SIGNATURE_HEADER = 'x-atoa-signature'

const SECRET_PREFIX = 'whsec_'
const SIGNATURE_PREFIX = 'v1='

/** The raw HMAC key from Atoa's `whsec_<base64>` secret, or null if the secret
 *  is not in that shape - which means the owner has pasted the wrong thing, and
 *  is worth failing loudly on rather than hashing with nonsense. */
export function atoaSigningKey(secret: string): Buffer | null {
  const trimmed = secret.trim()
  if (!trimmed.startsWith(SECRET_PREFIX)) return null
  const encoded = trimmed.slice(SECRET_PREFIX.length)
  if (!encoded) return null
  const key = Buffer.from(encoded, 'base64')
  // Buffer.from is famously forgiving about base64, so a non-empty result is
  // the only evidence there is that the payload decoded to anything.
  return key.length > 0 ? key : null
}

/** The hex digest half of an `X-Atoa-Signature` header, or null. */
export function atoaSignatureDigest(header: string): string | null {
  const trimmed = header.trim()
  if (!trimmed.startsWith(SIGNATURE_PREFIX)) return null
  const digest = trimmed.slice(SIGNATURE_PREFIX.length).trim()
  return /^[0-9a-fA-F]+$/.test(digest) ? digest.toLowerCase() : null
}

/**
 * Whether `header` is Atoa's signature over `rawBody`.
 *
 * The comparison is timing-safe, and both sides are compared as bytes rather
 * than strings so a digest of the wrong length is a mismatch instead of a
 * throw.
 */
export function verifyAtoaWebhookSignature(input: {
  rawBody: string
  header: string | null
  secret: string | null
}): boolean {
  if (!input.header || !input.secret) return false

  const key = atoaSigningKey(input.secret)
  if (!key) return false

  const received = input.header.startsWith(SIGNATURE_PREFIX)
    ? atoaSignatureDigest(input.header)
    // Tolerated: a bare hex digest with no scheme prefix. Atoa sends `v1=`
    // today, and a future scheme would arrive with its own prefix and be
    // refused above rather than checked against the wrong algorithm.
    : (/^[0-9a-fA-F]+$/.test(input.header.trim()) ? input.header.trim().toLowerCase() : null)
  if (!received) return false

  const expected = createHmac('sha256', key).update(input.rawBody, 'utf8').digest()
  const receivedBytes = Buffer.from(received, 'hex')
  if (receivedBytes.length !== expected.length) return false
  return timingSafeEqual(receivedBytes, expected)
}
