// Shared confirmation logic used by both the redirect-return route and the
// webhook: given our payment row and the current Atoa payment, move the shop
// order to its final state exactly once.
//
// Either path may arrive first and both routinely arrive within a second of
// each other, so everything here is idempotent.
import { getOrderById, markOrderAwaitingConfirmation, markOrderPaid, markOrderPaymentFailed, setOrderPaymentReference } from '@/modules/shop/lib/db/orders'
import { getCheckoutDraft, materialiseDraftOrder } from '@/modules/shop/lib/checkout-draft'
import { fulfillPaidOrder } from '@/modules/shop/lib/order-fulfillment'
import type { AtoaPaymentStatusResult } from '@/modules/pay-with-atoa-for-shop/lib/atoa'
import { atoaSettlementOutcome } from '@/modules/pay-with-atoa-for-shop/lib/status'
import { toPence } from '@/modules/pay-with-atoa-for-shop/lib/amount'
import { updateAtpPayment, type AtpPayment } from '@/modules/pay-with-atoa-for-shop/lib/db'

const LOG = '[pay-with-atoa]'

/** Whether a settled payment is genuinely for this order: same money, same
 *  currency. Exported for the tests.
 *
 *  It exists because in the modules this one is modelled on the check used to
 *  live in ONE of the two settlement paths. `confirmPayment` (the on-page
 *  confirm route) compared the figures and refused a mismatch; this function -
 *  which the webhook AND the redirect-return route both go through, and which
 *  is how most payments actually settle - marked the order PAID on the
 *  payment's status alone. So the guard was on the path least likely to be
 *  taken.
 *
 *  Both sides are compared in whole pence. Atoa deals in major units, the order
 *  total is a decimal string, and comparing two decimals as floats is how
 *  19.99 fails to equal 19.99. */
export function paymentMatchesOrder(
  payment: Pick<AtoaPaymentStatusResult, 'paidAmount' | 'currency'>,
  order: { total: unknown; currency: string },
): boolean {
  // No amount at all is not a match. Atoa omits it entirely until somebody has
  // actually paid, and "we could not see what was paid" must never be read as
  // "the right amount was paid".
  if (payment.paidAmount === null) return false
  const expected = toPence(Number(order.total))
  if (!Number.isFinite(expected)) return false
  if (toPence(payment.paidAmount) !== expected) return false
  return payment.currency.toUpperCase() === order.currency.toUpperCase()
}

export async function settleFromPayment(row: AtpPayment, payment: AtoaPaymentStatusResult): Promise<void> {
  await updateAtpPayment(row.id, { status: payment.status })

  const outcome = atoaSettlementOutcome(payment.status)

  if (outcome === 'not-started') {
    // The commonest status Atoa has, and it arrives with a perfectly happy HTTP
    // 200: every shopper who reached the checkout and then did not pay. Nothing
    // has happened, so nothing happens here. Emphatically NOT a failure - this
    // is the branch that would otherwise mark half the shop's checkouts as
    // failed payments.
    return
  }

  if (outcome === 'failed') {
    // No order at all means the shopper never got far enough to have one, which
    // is the entire point of drafting them: a payment that fell over leaves
    // nothing behind, so there is nothing here to mark as failed.
    const order = await getOrderById(row.orderId)
    if (!order) return
    if (order.paymentStatus === 'PAID') {
      // A late failure against an order that is already paid. Pay-by-bank has
      // no chargebacks, so this is not the reversal the GoCardless module has
      // to handle - it is a contradiction, and downgrading a paid order on the
      // strength of it would tell a shopper who has paid that they have not.
      // Logged loudly for a human instead.
      console.error(`${LOG} payment ${payment.paymentRequestId} reports ${payment.status} against order ${order.orderNumber}, which is already PAID - left alone`)
      return
    }
    await markOrderPaymentFailed(row.orderId, 'FAILED')
    return
  }

  // Never fulfil - or create - on status alone. A payment whose amount or
  // currency does not match is not this order's payment, and honouring it would
  // ship goods against money that was never charged for them. Checked against
  // the order where there is one, and against the draft where there is not yet,
  // because the check has to happen BEFORE the order is brought into being.
  const target = (await getOrderById(row.orderId)) ?? (await getCheckoutDraft(row.orderId))
  if (!target) {
    console.error(`${LOG} payment ${payment.paymentRequestId} settled against a missing order ${row.orderId}`)
    return
  }
  if (payment.paidAmount === null) {
    // Atoa reports no amount at all until somebody has actually paid.
    //
    // On a COMPLETED payment that is a contradiction, and one that cannot be
    // resolved in the shop's favour: fulfilling on a status with no money
    // attached is exactly the thing the check above exists to stop.
    if (outcome === 'paid') {
      console.error(`${LOG} payment ${payment.paymentRequestId} reports ${payment.status} with no amount - not fulfilling order ${target.orderNumber}`)
      return
    }
    // On a payment still in flight it is ordinary, and the order is brought
    // into being anyway. Nothing ships at AWAITING_CONFIRMATION, and the
    // COMPLETED that follows goes through the full check before a penny of it
    // is believed - whereas refusing here would leave a shopper whose money is
    // genuinely on its way with no order at all.
    console.warn(`${LOG} payment ${payment.paymentRequestId} is ${payment.status} with no amount reported - order ${target.orderNumber} parked pending`)
  } else if (!paymentMatchesOrder(payment, target)) {
    // Left unfulfilled and loudly logged so a human looks at it - deliberately
    // not failed either, because on a completed payment the money HAS been
    // taken and telling the shopper their payment failed would be its own kind
    // of wrong.
    console.error(
      `${LOG} payment ${payment.paymentRequestId} does not match order ${target.orderNumber}: ` +
      `paid ${payment.paidAmount} ${payment.currency}, order expects ${target.total} ${target.currency}`,
    )
    return
  }

  // The shopper has been through their bank, so by here the money is committed
  // even if it has not landed. That is the moment the order earns its
  // existence. Idempotent, so the redirect back and the webhook racing each
  // other create exactly one.
  const order = await materialiseDraftOrder(row.orderId)
  if (!order) {
    console.error(`${LOG} payment ${payment.paymentRequestId} could not be given an order (${row.orderId})`)
    return
  }

  if (outcome === 'pending') {
    // Authorised and on its way, but not settled yet. The shopper sees the
    // "awaiting" state and the webhook flips it to PAID when the money arrives.
    // Never downgrade an order that is already PAID.
    const fresh = await getOrderById(order.id)
    if (fresh && fresh.paymentStatus !== 'PAID') await markOrderAwaitingConfirmation(order.id)
    return
  }

  await setOrderPaymentReference(order.id, payment.paymentRequestId)
  // markOrderPaid is idempotent (no-op once already PAID), so a replayed
  // webhook can't fulfil the order twice.
  const justPaid = await markOrderPaid(order.id, payment.paymentRequestId)
  if (justPaid) await fulfillPaidOrder(order.id)
}
