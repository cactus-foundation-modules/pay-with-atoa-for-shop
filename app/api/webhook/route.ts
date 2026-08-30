// POST /api/m/pay-with-atoa-for-shop/webhook
// Atoa calls this when a payment changes state. Signature-verified; no session
// (Atoa is the caller).
//
// The body is a nudge, never evidence: whatever it says, the payment's state is
// read back from Atoa's own status endpoint before anything is settled. See
// lib/webhook-payload.ts for why.
import { NextRequest, NextResponse } from 'next/server'
import * as atoa from '@/modules/pay-with-atoa-for-shop/lib/atoa'
import { getAtoaWebhookSigningSecret } from '@/modules/pay-with-atoa-for-shop/lib/env'
import { getAtoaSettings } from '@/modules/pay-with-atoa-for-shop/lib/settings'
import { getAtpPaymentByOrderId, getAtpPaymentByPaymentRequestId } from '@/modules/pay-with-atoa-for-shop/lib/db'
import { settleFromPayment } from '@/modules/pay-with-atoa-for-shop/lib/settle'
import { ATOA_SIGNATURE_HEADER, verifyAtoaWebhookSignature } from '@/modules/pay-with-atoa-for-shop/lib/webhook-signature'
import { assessAtoaWebhookBody, isAtoaRefundEvent, type AtoaWebhookReference } from '@/modules/pay-with-atoa-for-shop/lib/webhook-payload'
import type { AtoaEnvironment } from '@/modules/pay-with-atoa-for-shop/lib/settings'

const LOG = '[pay-with-atoa]'

/** Whether this delivery was about a payment this shop knows. Returns false for
 *  one that is not ours - somebody else's payment on a shared Atoa account, or
 *  a refund notification - which is not a failure and must not be retried. */
async function handleReference(environment: AtoaEnvironment, ref: AtoaWebhookReference): Promise<boolean> {
  if (isAtoaRefundEvent(ref.eventType)) return false

  const row = ref.paymentRequestId
    ? await getAtpPaymentByPaymentRequestId(ref.paymentRequestId)
    // `orderId` is what this module sent on create, so it resolves a delivery
    // whose envelope does not repeat the payment request id.
    : ref.orderId ? await getAtpPaymentByOrderId(ref.orderId) : null
  if (!row?.paymentRequestId) return false

  await settleFromPayment(row, await atoa.getPaymentStatus(environment, row.paymentRequestId))
  return true
}

export async function POST(request: NextRequest) {
  // The signing secret belongs to an environment, so which environment the shop
  // is in decides which secret a delivery is checked against. A webhook still
  // in flight from the other environment fails the check and is refused, which
  // is the right answer: this shop is not taking payments there any more.
  const { environment } = await getAtoaSettings()
  const secret = getAtoaWebhookSigningSecret(environment)
  if (!secret) return new NextResponse('Not configured', { status: 503 })

  // Read RAW, before anything parses it. A body that has been through
  // JSON.parse and back is not the bytes Atoa signed and will never match.
  const rawBody = await request.text()
  const header = request.headers.get(ATOA_SIGNATURE_HEADER)
  if (!verifyAtoaWebhookSignature({ rawBody, header, secret })) {
    return new NextResponse('Invalid signature', { status: 403 })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return new NextResponse('Invalid payload', { status: 400 })
  }

  const delivery = assessAtoaWebhookBody(parsed)

  // A delivery this route could not find a payment in has NOT been handled, and
  // must never read as though it had. The envelope shape is the one assumption
  // in this module (no real Atoa body has ever been seen), so the shape being
  // wrong has to be loud rather than silent: answering 200 here would swallow
  // every genuine payment notification on the shop, and Atoa's retry - the only
  // second chance there is - would never fire.
  //
  // The keys are logged, and only the keys: they are what says whether the
  // envelope is the shape this module guessed at, and a webhook body carries a
  // payer's details that have no business in a log.
  if (delivery.references.length === 0) {
    console.error(
      `${LOG} webhook delivery carried no payment reference - event type(s) [${delivery.eventTypes.join(', ') || 'none readable'}], ` +
      `body keys [${delivery.bodyKeys.join(', ') || 'none'}]`,
    )
    // An event we subscribe to is always about a specific payment, so one with
    // no identifier means we failed to read it: 500, and let Atoa retry. An
    // event we do not subscribe to may legitimately carry none, and is allowed
    // to be the one thing this route shrugs at - having said so out loud first.
    if (delivery.unreadable) {
      return new NextResponse('No payment reference found in the delivery', { status: 500 })
    }
    return NextResponse.json({ ok: true, handled: 0, understood: false })
  }

  // One poison event must not fail the rest, because Atoa retries the whole
  // delivery and every handler here is idempotent - so each is caught
  // separately.
  //
  // But a delivery that failed must still be RETRIED. Answering 200 tells Atoa
  // it was dealt with, and Atoa's retries - exponential back-off for 24 hours,
  // then an email to the business owner - are the only second chance there is.
  // The GoCardless module shipped the swallow-and-200 version of this and one
  // transient database blip while settling was the last anyone heard of that
  // payment: the order sat at AWAITING_CONFIRMATION for ever with the shopper's
  // money gone. See the comment at
  // modules/gocardless-instant-bank-pay-for-shop/app/api/webhook/route.ts.
  let failed = 0
  let handled = 0
  for (const ref of delivery.references) {
    try {
      if (await handleReference(environment, ref)) handled++
    } catch (err) {
      failed++
      console.error(`${LOG} webhook event failed`, err)
    }
  }
  if (failed > 0) {
    return new NextResponse(`${failed} event(s) failed`, { status: 500 })
  }

  return NextResponse.json({ ok: true, handled })
}
