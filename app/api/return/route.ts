// GET /api/m/pay-with-atoa-for-shop/return
// The redirectUrl Atoa sends the shopper back to once they have been through
// their bank. Confirms server-side, then hands off to the shop confirmation
// page. The webhook remains the source of truth for settlement - this route is
// simply the first of the two to arrive most of the time.
//
// This method does not create its order until the money is committed (see
// shop's lib/checkout-draft), so there may be no order here at all - and where
// the shopper backed out on the bank's own page, there should not be. That case
// goes back to the checkout with the basket still in it, rather than to a
// confirmation page for something nobody paid for.
import { NextRequest, NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { signOrderReceiptToken } from '@/modules/shop/lib/order-receipt-token'
import { getOrderById } from '@/modules/shop/lib/db/orders'
import * as atoa from '@/modules/pay-with-atoa-for-shop/lib/atoa'
import { getAtpPaymentByOrderId } from '@/modules/pay-with-atoa-for-shop/lib/db'
import { getAtoaSettings } from '@/modules/pay-with-atoa-for-shop/lib/settings'
import { settleFromPayment } from '@/modules/pay-with-atoa-for-shop/lib/settle'

const LOG = '[pay-with-atoa]'

export async function GET(request: NextRequest) {
  const siteUrl = getSiteUrl()
  const checkoutUrl = `${siteUrl}/shop/checkout`

  const orderId = request.nextUrl.searchParams.get('order')
  if (!orderId) return NextResponse.redirect(checkoutUrl)

  const row = await getAtpPaymentByOrderId(orderId)
  if (!row?.paymentRequestId) return NextResponse.redirect(checkoutUrl)
  // Where a journey that never got started belongs. Same answer as the finished
  // one: back to the page the payment was begun on.
  const abandonedUrl = row.returnPath ? `${siteUrl}${row.returnPath}` : checkoutUrl

  try {
    const settings = await getAtoaSettings()
    // Asked of Atoa, never read out of the query string. Atoa appends its own
    // parameters to this URL, but they arrive through the payer's own browser
    // and anything a browser can carry is something a browser can be made to
    // carry - so the status comes from the API or it does not come at all.
    //
    // settleFromPayment does the rest: it checks the money is this order's,
    // creates the order if it has not been created yet, and marks it PAID or
    // awaiting depending on where the payment has got to. PAYMENT_NOT_INITIATED
    // - the shopper who opened the bank page and thought better of it - leaves
    // everything exactly as it was.
    await settleFromPayment(row, await atoa.getPaymentStatus(settings.environment, row.paymentRequestId))
  } catch (err) {
    // If Atoa is unreachable on return, leave things as they are; the webhook
    // settles it. Nothing here is the last word.
    console.error(`${LOG} return confirmation failed`, err)
  }

  // Read after settling, never before: on this method the order is very often
  // brought into being by the line above.
  const order = await getOrderById(orderId)
  if (!order) return NextResponse.redirect(abandonedUrl)

  // A payment started somewhere other than the checkout goes back where it came
  // from - the customer's own order page, for an unpaid order they have just
  // settled. A thank-you page for an order confirmed a fortnight ago is not
  // where that person was going. The path was stored when the payment was
  // created, never read out of this URL.
  if (row.returnPath) return NextResponse.redirect(`${siteUrl}${row.returnPath}`)

  // The signed receipt token, never the customer's email address. A redirect
  // URL lands in the site's access logs, the shopper's browser history and the
  // Referer header sent to every third party the confirmation page loads - and
  // an email address has no business in any of them. See shop's
  // lib/order-receipt-token, which the confirmation page verifies against.
  const confirmationUrl =
    `${siteUrl}/shop/checkout/confirmation` +
    `?orderNumber=${encodeURIComponent(order.orderNumber)}&t=${encodeURIComponent(signOrderReceiptToken(order.orderNumber))}`
  return NextResponse.redirect(confirmationUrl)
}
