// Atoa's payment statuses, and what each one means for a shop order.
//
// Every status Atoa can send is named here and nothing falls through. An
// unrecognised status throws, because an unhandled status on a payment route is
// how money goes quiet: the alternative - a "least-worst" default - either ships
// goods against a payment that never happened or tells a shopper who has paid
// that they have not.

export type AtoaPaymentStatus =
  // The commonest status there is, and it arrives with HTTP 200, not a 404:
  // every shopper who reaches the checkout and then does not pay. It means
  // "nothing has happened yet", and emphatically not "the payment failed".
  | 'PAYMENT_NOT_INITIATED'
  // Started at the bank, money not yet confirmed.
  | 'PENDING'
  // A card capture state. Unreachable while the module asks for PAY_BY_BANK
  // only, and reachable the moment an owner switches cards on - so it is
  // handled rather than assumed away.
  | 'AUTHORIZED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  // Inferred from the EXPIRED_STATUS webhook event Atoa publishes, and NOT
  // proved against a real delivery - expiry is not observable through the
  // status endpoint at all. Named anyway because the alternative is throwing on
  // it, and a payment link timing out is an ordinary thing that happens rather
  // than an emergency worth a 500 and 24 hours of Atoa's retries.
  | 'EXPIRED'

const KNOWN: readonly AtoaPaymentStatus[] = [
  'PAYMENT_NOT_INITIATED', 'PENDING', 'AUTHORIZED', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED',
]

/** Thrown rather than defaulted. See the note at the top of this file. */
export class UnknownAtoaStatusError extends Error {
  constructor(readonly raw: unknown) {
    super(`Atoa returned a payment status this module does not recognise: ${JSON.stringify(raw)}`)
    this.name = 'UnknownAtoaStatusError'
  }
}

export function parseAtoaPaymentStatus(raw: unknown): AtoaPaymentStatus {
  if (typeof raw === 'string') {
    const found = KNOWN.find((s) => s === raw)
    if (found) return found
  }
  throw new UnknownAtoaStatusError(raw)
}

/** What a status means for the order, in the four outcomes the settlement path
 *  actually distinguishes.
 *
 *   'not-started' - nothing has happened. Leave the order alone. This is NOT a
 *                   failure and must never reach markOrderPaymentFailed.
 *   'pending'     - the money is committed but not landed. The order earns its
 *                   existence and waits at AWAITING_CONFIRMATION.
 *   'paid'        - the money is in. Fulfil.
 *   'failed'      - it is not coming. Nothing was drafted into an order, or the
 *                   order that exists is marked failed.
 */
export type AtoaSettlementOutcome = 'not-started' | 'pending' | 'paid' | 'failed'

export function atoaSettlementOutcome(status: AtoaPaymentStatus): AtoaSettlementOutcome {
  switch (status) {
    case 'PAYMENT_NOT_INITIATED':
      return 'not-started'
    case 'PENDING':
    case 'AUTHORIZED':
      return 'pending'
    case 'COMPLETED':
      return 'paid'
    case 'FAILED':
    case 'CANCELLED':
    case 'EXPIRED':
      return 'failed'
  }
}

// --- Refunds ---------------------------------------------------------------
//
// DOCUMENTED ONLY, never proved: refunds are not enabled on the Atoa account
// this was built against ("Refunds are not available for this account", 405 on
// both the initiate and the status call), so no refund response has ever been
// seen. Which is exactly why an unrecognised value throws here too, and why the
// provider turns a throw into ShpRefundStatusLookup's 'unknown' - the value
// that means "do not touch this row", rather than guessing about money in
// either direction.

export type AtoaRefundStatus = 'INITIATED' | 'COMPLETED' | 'FAILED'

const KNOWN_REFUND: readonly AtoaRefundStatus[] = ['INITIATED', 'COMPLETED', 'FAILED']

export function parseAtoaRefundStatus(raw: unknown): AtoaRefundStatus {
  if (typeof raw === 'string') {
    const found = KNOWN_REFUND.find((s) => s === raw)
    if (found) return found
  }
  throw new UnknownAtoaStatusError(raw)
}
