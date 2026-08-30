import { describe, expect, it } from 'vitest'
import {
  ATOA_SUBSCRIBED_EVENTS, assessAtoaWebhookBody, atoaWebhookBodyKeys, atoaWebhookEventTypes,
  atoaWebhookReferences, isAtoaRefundEvent,
} from '@/modules/pay-with-atoa-for-shop/lib/webhook-payload'
import { ATOA_WEBHOOK_EVENTS } from '@/modules/pay-with-atoa-for-shop/lib/atoa'

describe('atoaWebhookReferences', () => {
  it('reads a flat event', () => {
    expect(atoaWebhookReferences({ eventType: 'PAYMENTS_STATUS', paymentRequestId: 'pr_1', orderId: 'ord_1' })).toEqual([
      { eventType: 'PAYMENTS_STATUS', paymentRequestId: 'pr_1', orderId: 'ord_1' },
    ])
  })

  // No real webhook body has ever been seen (stage 1 had no publicly reachable
  // URL to receive one at), so the envelope shape is the thing this parser is
  // least entitled to assume. An envelope must work.
  it('reads an event wrapped in an envelope, inheriting the event type', () => {
    expect(atoaWebhookReferences({ eventType: 'PAYMENTS_STATUS', data: { paymentRequestId: 'pr_1' } })).toEqual([
      { eventType: 'PAYMENTS_STATUS', paymentRequestId: 'pr_1', orderId: null },
    ])
  })

  it('reads a batch', () => {
    const refs = atoaWebhookReferences([
      { eventType: 'PAYMENTS_STATUS', paymentRequestId: 'pr_1' },
      { eventType: 'EXPIRED_STATUS', paymentRequestId: 'pr_2' },
    ])
    expect(refs.map((r) => r.paymentRequestId)).toEqual(['pr_1', 'pr_2'])
    expect(refs.map((r) => r.eventType)).toEqual(['PAYMENTS_STATUS', 'EXPIRED_STATUS'])
  })

  // An envelope that repeats the identifiers is one job, not two: settling is
  // idempotent, so a duplicate is harmless, but it is a wasted round trip to
  // Atoa on every single delivery.
  it('does not report the same payment twice', () => {
    expect(atoaWebhookReferences({ paymentRequestId: 'pr_1', data: { paymentRequestId: 'pr_1' } })).toEqual([
      { eventType: null, paymentRequestId: 'pr_1', orderId: null },
    ])
  })

  it('reports an orderId-only event, which is the reference this module sent on create', () => {
    expect(atoaWebhookReferences({ orderId: 'ord_1' })).toEqual([
      { eventType: null, paymentRequestId: null, orderId: 'ord_1' },
    ])
  })

  it('finds nothing in a body with no identifiers, rather than inventing one', () => {
    expect(atoaWebhookReferences({ eventType: 'PAYMENTS_STATUS', status: 'COMPLETED' })).toEqual([])
    expect(atoaWebhookReferences({})).toEqual([])
    expect(atoaWebhookReferences(null)).toEqual([])
    expect(atoaWebhookReferences('COMPLETED')).toEqual([])
    expect(atoaWebhookReferences(42)).toEqual([])
  })

  it('ignores identifiers that are not non-empty strings', () => {
    expect(atoaWebhookReferences({ paymentRequestId: 123, orderId: '   ' })).toEqual([])
  })

  it('trims a padded identifier', () => {
    expect(atoaWebhookReferences({ paymentRequestId: ' pr_1 ' })[0]?.paymentRequestId).toBe('pr_1')
  })

  // A hostile body must not be able to make the walk run for ever.
  it('stops descending at a bounded depth', () => {
    let deep: Record<string, unknown> = { paymentRequestId: 'pr_deep' }
    for (let i = 0; i < 12; i++) deep = { data: deep }
    expect(atoaWebhookReferences(deep)).toEqual([])
  })

  it('takes the nearest event type rather than an outer one', () => {
    expect(atoaWebhookReferences({ eventType: 'PAYMENTS_STATUS', data: { eventType: 'REFUND_STATUS', paymentRequestId: 'pr_1' } })).toEqual([
      { eventType: 'REFUND_STATUS', paymentRequestId: 'pr_1', orderId: null },
    ])
  })
})

describe('isAtoaRefundEvent', () => {
  // Refunds are recorded in the shop and paid from the owner's own bank in this
  // release, so a refund delivery has nothing to settle - and settling it would
  // send the module off to re-read a payment that has not changed.
  it('recognises a refund delivery', () => {
    expect(isAtoaRefundEvent('REFUND_STATUS')).toBe(true)
  })

  it('leaves every other delivery alone, including one with no event type at all', () => {
    expect(isAtoaRefundEvent('PAYMENTS_STATUS')).toBe(false)
    expect(isAtoaRefundEvent('EXPIRED_STATUS')).toBe(false)
    expect(isAtoaRefundEvent(null)).toBe(false)
  })
})

describe('assessAtoaWebhookBody', () => {
  // THE defect this exists for. If the envelope guess is wrong - and no real
  // Atoa body has ever been seen - then a PAYMENTS_STATUS delivery yields no
  // reference, the settle loop runs zero times, and a route that answered 200
  // would tell Atoa the delivery was handled. The shopper pays, closes the tab,
  // gets no order; the owner gets no email; Atoa's 24-hour retry, which is the
  // only second chance there is, never fires.
  it('marks a subscribed event with no identifier as unreadable, so the route answers 500', () => {
    const assessment = assessAtoaWebhookBody({ eventType: 'PAYMENTS_STATUS', status: 'COMPLETED' })
    expect(assessment.references).toEqual([])
    expect(assessment.unreadable).toBe(true)
  })

  it('does the same for the other two events we subscribe to', () => {
    expect(assessAtoaWebhookBody({ eventType: 'EXPIRED_STATUS' }).unreadable).toBe(true)
    expect(assessAtoaWebhookBody({ eventType: 'REFUND_STATUS' }).unreadable).toBe(true)
  })

  // An unreadable body on a payment webhook is not a success either.
  it('treats a body with no readable event type at all as unreadable', () => {
    expect(assessAtoaWebhookBody({ hello: 'world' }).unreadable).toBe(true)
    expect(assessAtoaWebhookBody({}).unreadable).toBe(true)
    expect(assessAtoaWebhookBody(null).unreadable).toBe(true)
    expect(assessAtoaWebhookBody('COMPLETED').unreadable).toBe(true)
  })

  // A delivery with an identifier IS understood, whether or not the payment
  // turns out to be this shop's. Somebody else's payment on a shared Atoa
  // account is a fact, not a failure.
  it('is readable the moment an identifier is present', () => {
    const assessment = assessAtoaWebhookBody({ eventType: 'PAYMENTS_STATUS', paymentRequestId: 'pr_1' })
    expect(assessment.unreadable).toBe(false)
    expect(assessment.references).toHaveLength(1)
  })

  // The one thing this route is allowed to shrug at, and only after saying so.
  it('lets an event we do not subscribe to pass without an identifier', () => {
    expect(assessAtoaWebhookBody({ eventType: 'POS_PAYMENT_STATUS' }).unreadable).toBe(false)
  })

  it('reports the top-level keys for the log, and no values', () => {
    expect(assessAtoaWebhookBody({ eventType: 'PAYMENTS_STATUS', payer: { email: 'a@b.c' } }).bodyKeys)
      .toEqual(['eventType', 'payer'])
    expect(atoaWebhookBodyKeys([{ eventType: 'PAYMENTS_STATUS' }])).toEqual(['array[1]', 'eventType'])
    expect(atoaWebhookBodyKeys('nope')).toEqual([])
  })

  it('names every event type in the delivery', () => {
    expect(atoaWebhookEventTypes([{ eventType: 'PAYMENTS_STATUS' }, { eventType: 'EXPIRED_STATUS' }, { eventType: 'PAYMENTS_STATUS' }]))
      .toEqual(['PAYMENTS_STATUS', 'EXPIRED_STATUS'])
  })

  // The list here and the list the endpoint is registered with have to be the
  // same list, or an event we subscribe to could quietly stop being one that
  // must carry an identifier. Kept honest here rather than by importing the
  // REST client into a pure parser.
  it('agrees with the events the webhook endpoint is registered for', () => {
    expect([...ATOA_SUBSCRIBED_EVENTS].sort()).toEqual([...ATOA_WEBHOOK_EVENTS].sort())
  })
})
