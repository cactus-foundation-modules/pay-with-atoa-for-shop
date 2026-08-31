// What the dialog's four callbacks mean, and what the shopper gets told.
//
// Pure and on its own so every outcome can be asserted without a browser. A
// payment window that goes away and leaves the checkout looking exactly as it
// did is how somebody ends up pressing "Place order" three times, so every way
// one can end has a sentence here.
//
// Three of the dialog's four callbacks end a payment: a status it calls
// terminal, the shopper closing it, the shopper cancelling. The fourth,
// onError, does not - Atoa reports a problem and keeps its window open on its
// own error pane - so it only decides which sentence the eventual close
// produces.
//
// Every sentence here is shopper-facing copy, because throwing from the submit
// function stops the order and shows the thrown message on the checkout's own
// error line. No status codes, no provider jargon, and never Atoa's own
// internal wording ("[Atoa Web SDK] Error displaying payment dialog" is a note
// for a developer's console, which is where it stays).

export const ATOA_MESSAGES = {
  /** onUserCancel. Not a failure: the shopper decided against it, and nothing
   *  has been created, charged or lost. */
  cancelled: 'Payment cancelled. Nothing has been taken, and your basket is exactly as you left it.',
  /** onClose with nothing terminal in it - the same thing by another route
   *  (the X, the scrim, the escape key). */
  closed: 'The payment window closed before your bank had finished. Nothing has been taken - have another go whenever you are ready.',
  /** A FAILED status from the dialog. The money did not move. */
  failed: 'Your bank did not complete the payment. Nothing has been taken - please try again, or choose another way to pay.',
  /** The dialog reported a problem of its own (onError) and the shopper then
   *  shut it. Not thrown at the moment of the report: Atoa's window stays up
   *  and says its piece, and the shopper decides when it is over. */
  errored: 'The bank payment window ran into a problem. Nothing has been taken - please try again, or choose another way to pay.',
  /** The SDK would not load, or answered with something that is not the SDK. */
  loadFailed: 'The bank payment window could not be loaded. Please try again, or choose another way to pay.',
  /** No payment request id, or no environment, in the config handed over at
   *  submit time. The shopper can do nothing about it but wait a moment. */
  notReady: 'This order is not ready to be paid for yet. Please try again in a moment.',
} as const

/** What the dialog's status stream means for the order.
 *
 *   'settled' - Atoa says the payment is done. Hand off to the server, which
 *               asks Atoa itself before anything is fulfilled.
 *   'failed'  - it is not coming.
 *   'waiting' - anything else. Keep the dialog open; the shopper is still in
 *               the middle of it.
 *
 * **PENDING is 'waiting', not 'settled'**, and that is not a judgement call:
 * the SDK's own payment-details call answers `"status":"PENDING"` for a payment
 * request nobody has so much as looked at (proved in sandbox against a freshly
 * created request, where the merchant status endpoint said
 * PAYMENT_NOT_INITIATED). Treating it as money committed would confirm an order
 * for a shopper who is still choosing their bank. A payment that completes
 * after the shopper closes the dialog is not lost either way: Atoa's webhook
 * creates the order from this module's own payment row.
 */
export type AtoaClientOutcome = 'settled' | 'failed' | 'waiting'

export function atoaClientOutcome(status: unknown): AtoaClientOutcome {
  if (status === 'COMPLETED') return 'settled'
  if (status === 'FAILED') return 'failed'
  return 'waiting'
}

/** The message for a dialog that closed. `onClose` carries the last status it
 *  had, so a close on a FAILED payment says so rather than pretending the
 *  shopper simply changed their mind.
 *
 *  `errored` is whether the dialog reported a problem of its own while it was
 *  open (see the onError note in AtoaCheckoutFields). Atoa keeps its window up
 *  after one of those and draws its own error pane, so the shopper's next move
 *  is to close it - and being told the window "closed before your bank had
 *  finished" when they had just been looking at an error is the wrong end of
 *  the story. */
export function atoaCloseMessage(status: unknown, errored = false): string {
  if (atoaClientOutcome(status) === 'failed') return ATOA_MESSAGES.failed
  return errored ? ATOA_MESSAGES.errored : ATOA_MESSAGES.closed
}
