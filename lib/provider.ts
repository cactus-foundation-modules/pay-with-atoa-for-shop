// The Pay With Atoa payment provider, registered into the shop checkout via the
// `shop.payment-providers` extension point (see the manifest).
//
// The shopper either goes to Atoa's own hosted page and comes back, or
// authorises in Atoa's dialog over this site's own checkout - the owner's
// choice, stored as `paymentEntry`. The two part company in exactly one place,
// lib/intent.ts: never both an approvalUrl and clientFields on the same intent,
// because that gives the checkout two contradictory instructions.
import { getSiteUrl } from '@/lib/config/env'
import type {
  ShpOrderDraft, ShpPaymentIntent, ShpPaymentProvider, ShpPaymentResult,
  ShpRefundRequest, ShpRefundResult,
} from '@/modules/shop/lib/payments/provider'
import { isAtoaConfigured } from '@/modules/pay-with-atoa-for-shop/lib/env'
import { atoaLogo } from '@/modules/pay-with-atoa-for-shop/lib/logo'
import { getAtoaSettings, MAX_PAYMENT_DESCRIPTION_LENGTH } from '@/modules/pay-with-atoa-for-shop/lib/settings'
import * as atoa from '@/modules/pay-with-atoa-for-shop/lib/atoa'
import { atoaSettlementOutcome } from '@/modules/pay-with-atoa-for-shop/lib/status'
import { ATOA_CURRENCY, ATOA_MINIMUM_AMOUNT, isAtoaCurrency, isBelowAtoaMinimum, roundToPennies, toPence } from '@/modules/pay-with-atoa-for-shop/lib/amount'
import { createAtpPayment, getAtpPaymentByOrderId, updateAtpPayment } from '@/modules/pay-with-atoa-for-shop/lib/db'
import { atoaPaymentIntent } from '@/modules/pay-with-atoa-for-shop/lib/intent'

const METHOD_ID = 'ATOA'
const RETURN_PATH = '/api/m/pay-with-atoa-for-shop/return'

// A path on this site, or nothing at all.
//
// The shop hands this over and the shop is trustworthy, but what is built from
// it is a URL somebody's browser will be sent to - so it is checked here rather
// than assumed, and checked for the shape that matters: one leading slash, and
// no second one. "//evil.example" is a protocol-relative URL, and a browser
// treats it as another site entirely.
function safeReturnPath(path: string | undefined): string | null {
  if (!path || !path.startsWith('/') || path.startsWith('//')) return null
  return path
}

// Atoa asks for the payer's name in two halves; a checkout collects it as one
// line. A name that does not split into two is left out entirely rather than
// guessed at, since a half-filled name would only have to be corrected at the
// bank.
function splitCustomerName(fullName: string): { firstName?: string; lastName?: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]
  if (parts.length < 2 || !first) return {}
  return { firstName: first, lastName: parts.slice(1).join(' ') }
}

// Offered at checkout only when the credentials for the live environment are
// set AND the owner has turned the method on in its settings tab.
async function isAvailable(): Promise<boolean> {
  const settings = await getAtoaSettings()
  if (!settings.enabled) return false
  return isAtoaConfigured(settings.environment)
}

// The publishable, order-independent half: which of Atoa's two environments the
// shop is in. Spelled the way Atoa's own web SDK expects it, so the dialog can
// hand it straight over. Nothing secret, and nothing order-specific - this goes
// to every shopper who loads the checkout.
//
// null in redirect mode, and that is load-bearing rather than tidy: shop mounts
// a method's fields component the moment this returns anything at all, so a
// shop set to the hosted redirect would otherwise draw the on-page component -
// and fetch Atoa's SDK onto its checkout - for a shopper who is going to be
// redirected anyway.
async function getClientFields(): Promise<Record<string, unknown> | null> {
  const settings = await getAtoaSettings()
  if (settings.paymentEntry !== 'on-page') return null
  if (!(await isAvailable())) return null
  return { environment: settings.environment === 'production' ? 'PRODUCTION' : 'SANDBOX' }
}

async function createIntent(order: ShpOrderDraft): Promise<ShpPaymentIntent> {
  const settings = await getAtoaSettings()

  // Atoa is a UK open-banking provider and takes pounds only. `currency` is not
  // even a field on its create call - it is accepted and ignored - so an order
  // priced in euros would be charged the same number in pounds. Refused here
  // rather than sent and hoped for. The message is what the shopper reads.
  if (!isAtoaCurrency(order.currency)) {
    throw new Error(`Pay by bank is only available for orders priced in ${ATOA_CURRENCY}.`)
  }
  // Atoa refuses anything under a pound outright, with a 400 nobody can act on.
  // isAvailable cannot see the basket total, so the floor has to be caught here.
  if (isBelowAtoaMinimum(order.amount)) {
    throw new Error(`Pay by bank cannot be used for orders under £${ATOA_MINIMUM_AMOUNT.toFixed(2)}.`)
  }

  const amount = roundToPennies(order.amount)
  const returnPath = safeReturnPath(order.returnPath)

  // Atoa honours no idempotency mechanism on create: a repeated orderId simply
  // makes a second payment request, and the standard Idempotency-Key header is
  // ignored (both proved against the sandbox). So a shopper who double-submits
  // would otherwise end up with two live payment links for one order, and could
  // pay both. Hand back the one that already exists instead - only while it is
  // genuinely untouched, still inside its expiry, and for the same money.
  const existing = await getAtpPaymentByOrderId(order.orderId)
  if (
    existing?.paymentRequestId &&
    existing.paymentUrl &&
    // The literal, rather than the parsed status: an unrecognised value from a
    // future version of this module should fall through to a fresh request, not
    // throw on a checkout.
    existing.status === 'PAYMENT_NOT_INITIATED' &&
    toPence(Number(existing.amount)) === toPence(amount) &&
    existing.currency.toUpperCase() === order.currency.toUpperCase() &&
    Date.now() - existing.createdAt.getTime() < settings.expiresInMinutes * 60_000
  ) {
    return atoaPaymentIntent(settings.paymentEntry, {
      paymentRequestId: existing.paymentRequestId,
      paymentUrl: existing.paymentUrl,
    })
  }

  // Capped at 30 characters because Atoa rejects anything longer outright. The
  // settings tab counts the owner down to the same limit, so this is a backstop
  // rather than the first line of defence.
  const description = settings.paymentDescription.trim()
  const notes = (description || `Order ${order.orderNumber}`).slice(0, MAX_PAYMENT_DESCRIPTION_LENGTH)

  const created = await atoa.createPaymentRequest(settings.environment, {
    orderId: order.orderId,
    amount,
    // Atoa's own grouping key for a payer, not a Cactus id. The email is the
    // most stable thing the checkout has; the order id stands in for a shop
    // that does not ask for one.
    customerId: order.customerEmail.trim() || order.orderId,
    redirectUrl: `${getSiteUrl()}${RETURN_PATH}?order=${encodeURIComponent(order.orderId)}`,
    expiresInMs: settings.expiresInMinutes * 60_000,
    notes,
    consumer: {
      ...(order.customerEmail.trim() ? { email: order.customerEmail.trim() } : {}),
      ...splitCustomerName(order.customerName),
    },
    // Cards are Atoa's other trick, and in the dialog they are not Atoa's own
    // work at all: the SDK loads Rapyd's checkout toolkit from a third origin
    // and draws the card form in Rapyd's iframe. That is a payment page pulling
    // in a fourth party's script, on origins this module has deliberately not
    // put into every install's Content-Security-Policy - so in on-page mode the
    // card step could only ever fail in front of a shopper. Pay-by-bank only
    // there, said plainly in the settings tab rather than done quietly.
    allowCard: settings.allowCard && settings.paymentEntry === 'redirect',
  })

  await createAtpPayment({
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    paymentRequestId: created.paymentRequestId,
    paymentUrl: created.paymentUrl,
    amount,
    currency: ATOA_CURRENCY,
    // Kept here rather than in the return URL: that URL comes back through the
    // payer's own browser, so a destination read out of it is one anybody can
    // write.
    returnPath,
  })

  return atoaPaymentIntent(settings.paymentEntry, created)
}

// What the confirm route calls. The redirect-return route and the webhook are
// the other two ways a payment settles; this one reports where the payment has
// got to, re-validating amount and currency and never trusting the client
// payload - which is why the payload is not read at all.
//
// That matters most in on-page mode, where the dialog itself says a payment
// completed. It says so because Atoa's own server told it, but the browser is
// still only a hint about WHEN to look: the answer comes from asking Atoa
// again, from here, and the amount and currency are checked against the order
// either way.
async function confirmPayment(order: ShpOrderDraft): Promise<ShpPaymentResult> {
  const settings = await getAtoaSettings()
  const row = await getAtpPaymentByOrderId(order.orderId)
  if (!row?.paymentRequestId) return { success: false, error: 'No Atoa payment was found for this order.' }

  const payment = await atoa.getPaymentStatus(settings.environment, row.paymentRequestId)
  await updateAtpPayment(row.id, { status: payment.status })

  const outcome = atoaSettlementOutcome(payment.status)
  if (outcome === 'not-started') {
    // The commonest status Atoa has, and it arrives as a perfectly happy 200.
    // It means the shopper has not been through their bank yet.
    //
    // WATCH THIS ON THE FIRST REAL ON-PAGE PAYMENT. There are two different
    // status endpoints in play: Atoa's dialog learns COMPLETED from its own
    // SDK-side status call, and this asks the merchant-side one
    // (GET /api/payments/v1/payment-status/{id}). If the merchant side ever
    // lags behind, this branch tells somebody who HAS just paid that they have
    // not - and their natural next move, pressing "Place order" again, reopens
    // Atoa's dialog on the same payment request, because shop keeps the
    // prepared intent through a failed confirm. What Atoa does with an
    // already-COMPLETED request has never been observed.
    //
    // No retry has been added, deliberately: there is no evidence the lag
    // exists (the dialog learns COMPLETED from Atoa's own server, so it cannot
    // be ahead of Atoa), a poll here would slow down every genuine "not paid
    // yet" answer, and this same function settles an existing order from the
    // customer's own order page, where the delay would buy nothing. Unobserved
    // rather than dismissed - if a first live on-page payment reports this
    // wrongly, this is the place, and a single bounded re-read is the fix.
    return { success: false, error: 'This payment has not been completed with your bank yet.' }
  }
  if (outcome === 'failed') return { success: false, error: 'The bank payment did not go through.' }

  if (payment.paidAmount !== null) {
    if (toPence(payment.paidAmount) !== toPence(order.amount)) {
      return { success: false, error: 'Payment amount does not match this order.' }
    }
    if (payment.currency.toUpperCase() !== order.currency.toUpperCase()) {
      return { success: false, error: 'Payment currency does not match this order.' }
    }
  } else if (outcome === 'paid') {
    // Completed, with no amount to check it against. Not something to confirm
    // on - see the same guard in settle.ts.
    return { success: false, error: 'This payment could not be confirmed. Please contact us before trying again.' }
  }

  return { success: true, pending: outcome === 'pending', providerReference: row.paymentRequestId }
}

// Records the refund; it does not move the money, because nothing here can yet.
//
// Atoa provisions refunds per merchant account, and on an account without them
// both refund endpoints answer 405 - "Refunds are not available for this
// account. Please contact support." So this module ships as a MANUAL refund
// method, the same as bank transfer and cash: pressing Refund takes the items
// off the order, credits the books and sends the customer their credit note,
// and whoever pressed it still has to send the money from their bank.
//
// Returning a refusal instead would be worse, and is a mistake this platform
// has already made once: a shop whose only method could not record a refund
// kept the whole sale in its books, never got its stock back and never sent a
// credit note, while the modal cheerfully said it had been recorded. See
// `refundMode` on ShpPaymentProvider.
//
// The API side of refunds is written and waiting in lib/atoa.ts and lib/db.ts
// for the release that turns this back on - see the note above initiateRefund.
async function refundOrder(_refund: ShpRefundRequest): Promise<ShpRefundResult> {
  return { success: true }
}

// No getRefundStatus, deliberately. It answers "did this refund actually
// happen?" for the shop's stale-PENDING reconciler, and a manual refund settles
// the moment it is recorded - there is no provider row left in flight to
// reconcile, and nothing to ask Atoa about.

export const atoaProvider: ShpPaymentProvider = {
  id: METHOD_ID,
  label: 'Pay by bank',
  description: 'Pay directly from your bank account. No card needed.',
  // Atoa's own wordmark, from the SVG they publish. See lib/logo.ts.
  logo: atoaLogo,
  confirmMode: 'auto',
  // The shopper authorises this at their own bank, on a page this site never
  // sees, and most of the people who go there do not come back. An order
  // written before they left would be an order nobody had paid for, sitting in
  // the owner's list looking exactly like one somebody had - so the checkout
  // drafts it instead and settle.ts creates it the moment the money is
  // committed.
  orderCreation: 'on-payment',
  // Nothing here assumes a checkout. createIntent works off an order id and an
  // amount, and every settlement path goes through materialiseDraftOrder, which
  // hands back an order that already exists just as happily as it creates one -
  // so a bank transfer that has gone unpaid can be settled from the customer's
  // own order page.
  settlesExistingOrder: true,
  // Manual, not 'provider'. Atoa's refund endpoints are switched off at the
  // account level, so a provider-mode Refund button would call Atoa, collect a
  // 405 and read to the owner as a broken Cactus. Manual is the honest answer
  // until Atoa enable the account - see refundOrder.
  refundMode: 'manual',
  isAvailable,
  getClientFields,
  createIntent,
  confirmPayment,
  refundOrder,
}
