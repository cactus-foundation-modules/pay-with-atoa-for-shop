// The one place the hosted redirect and the on-page dialog part company.
//
// Pure and on its own so the rule below can be asserted without a database, an
// Atoa key or a checkout, because it is a rule that cannot be half-kept:
//
//   redirect - { approvalUrl, providerOrderId }
//   on-page  - { providerOrderId, clientFields: { paymentRequestId } }
//
// **Never both.** Shop reads an intent carrying an approvalUrl as "hand the
// shopper over" and one carrying clientFields as "mount this method's own
// fields and wait for them" - and it checks for the approvalUrl first
// (CheckoutPaymentClient), so an intent with both would redirect the shopper
// away from fields it had just drawn for them. Two contradictory instructions,
// one of them silently winning.
import type { ShpPaymentIntent } from '@/modules/shop/lib/payments/provider'
import type { AtoaPaymentEntry } from '@/modules/pay-with-atoa-for-shop/lib/settings'

export type AtoaCreatedPayment = {
  paymentRequestId: string
  // Atoa's own hosted page for this request. Held even in on-page mode: the
  // same payment request can still be settled from its hosted page, and the
  // owner may switch the setting back with live requests outstanding.
  paymentUrl: string
}

export function atoaPaymentIntent(entry: AtoaPaymentEntry, created: AtoaCreatedPayment): ShpPaymentIntent {
  if (entry === 'on-page') {
    return {
      providerOrderId: created.paymentRequestId,
      // The whole per-order half. Which of Atoa's environments the shop is in
      // comes from getClientFields, resolved when the shopper picked the method
      // - shop merges the two before handing them to the fields component.
      //
      // Publishable, and nothing here can be acted on unilaterally: a payment
      // request id opens Atoa's own dialog and nothing else, and the server
      // still asks Atoa whether the money actually moved.
      clientFields: { paymentRequestId: created.paymentRequestId },
    }
  }
  return { approvalUrl: created.paymentUrl, providerOrderId: created.paymentRequestId }
}
