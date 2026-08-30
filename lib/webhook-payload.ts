// Reading an Atoa webhook body: which payments it refers to, and - just as
// important - whether it was understood at all.
//
// Deliberately tolerant, and deliberately incurious. NO webhook body has ever
// been seen for real - stage 1 could not receive one without a publicly
// reachable URL - so the exact envelope is not something this module is
// entitled to assume. What it needs is small and stable: which payment the
// delivery is about. Everything that matters afterwards is asked of Atoa's own
// status endpoint.
//
// That is not a shortcut, it is the design. A webhook body arrives from
// somewhere on the internet; a signature says it came from Atoa but says
// nothing about whether the shape has changed since. So the body is used as a
// nudge - "look at this payment again" - and never as evidence of anything.
// A route that read the status straight out of the body would be one field
// rename away from marking orders paid that were not.
//
// The corollary, and the reason assessAtoaWebhookBody exists: because the
// envelope IS a guess, the guess being wrong has to be loud. A delivery this
// file could not find a payment in is not a delivery that was handled, and the
// route must never answer 200 to one. See the note on `unreadable` below.

const REFERENCE_KEYS = ['paymentRequestId', 'orderId'] as const
const EVENT_KEYS = ['eventType', 'event', 'type'] as const

// Deep enough for an envelope wrapped in a batch wrapped in a payload; shallow
// enough that a hostile body cannot make this walk for ever.
const MAX_DEPTH = 4

// The events this module subscribes to. Every one of them is about a specific
// payment or refund, so every one of them MUST carry an identifier - a delivery
// of one that does not is a delivery we failed to understand.
//
// Held here rather than imported from lib/atoa.ts on purpose: this file is pure
// string handling and has no business pulling in the REST client. The two lists
// are kept honest by a test that compares them, so they cannot drift.
export const ATOA_SUBSCRIBED_EVENTS = ['PAYMENTS_STATUS', 'EXPIRED_STATUS', 'REFUND_STATUS'] as const

export type AtoaWebhookReference = {
  // Atoa's own name for the event, where the body carries one. V2 signing adds
  // `eventType`; the field is optional here because nothing depends on it being
  // present - it is used to SKIP work, never to authorise any.
  eventType: string | null
  paymentRequestId: string | null
  // The reference this module sent on create: the shop's order (or draft) id.
  orderId: string | null
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function readEventType(source: Record<string, unknown>): string | null {
  for (const key of EVENT_KEYS) {
    const value = readString(source, key)
    if (value) return value
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Every object in the body, paired with the event type in force where it sits.
 *
 *  One bounded walk, shared by everything below, so "what did this delivery
 *  say" and "did we understand it" can never disagree about what they looked
 *  at. The event type is inherited from the nearest enclosing object that names
 *  one, so an envelope of the form `{ eventType, data: { paymentRequestId } }`
 *  still reports which event it was. */
function walk(body: unknown, depth: number, inheritedEventType: string | null): Array<{ record: Record<string, unknown>; eventType: string | null }> {
  if (depth > MAX_DEPTH) return []

  if (Array.isArray(body)) {
    return body.flatMap((entry) => walk(entry, depth + 1, inheritedEventType))
  }
  if (!isRecord(body)) return []

  const eventType = readEventType(body) ?? inheritedEventType
  const found = [{ record: body, eventType }]
  for (const value of Object.values(body)) {
    if (isRecord(value) || Array.isArray(value)) found.push(...walk(value, depth + 1, eventType))
  }
  return found
}

/**
 * Every payment an Atoa webhook body refers to, in the order they appear.
 *
 * Handles a single event, an array of them, and an event wrapped in an
 * envelope, because all three are ordinary shapes for a payments webhook and
 * only one of them can be right. An object carrying neither identifier
 * contributes nothing; the walk continues through it in case the identifiers
 * are a level down.
 */
export function atoaWebhookReferences(body: unknown): AtoaWebhookReference[] {
  const found: AtoaWebhookReference[] = []
  for (const { record, eventType } of walk(body, 0, null)) {
    const paymentRequestId = readString(record, REFERENCE_KEYS[0])
    const orderId = readString(record, REFERENCE_KEYS[1])
    if (paymentRequestId || orderId) found.push({ eventType, paymentRequestId, orderId })
  }

  // A nested copy of the same identifiers - an envelope that repeats them, or a
  // batch mentioning one payment twice - is one job, not two. Settling is
  // idempotent, so a duplicate would be harmless; it would also be a wasted
  // round trip to Atoa on every delivery.
  const seen = new Set<string>()
  return found.filter((ref) => {
    const key = `${ref.paymentRequestId ?? ''}|${ref.orderId ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Every event type named anywhere in the body, deduplicated. */
export function atoaWebhookEventTypes(body: unknown): string[] {
  const types = new Set<string>()
  for (const { record } of walk(body, 0, null)) {
    const named = readEventType(record)
    if (named) types.add(named)
  }
  return [...types]
}

/** The body's own top-level field names, for the log line - names only, never
 *  values. A webhook body carries a payer's details, and a log is not the place
 *  for them; the names alone are what says whether the envelope is the shape
 *  this file guessed at. */
export function atoaWebhookBodyKeys(body: unknown): string[] {
  if (Array.isArray(body)) {
    const first = body.find(isRecord)
    return first ? [`array[${body.length}]`, ...Object.keys(first)] : [`array[${body.length}]`]
  }
  return isRecord(body) ? Object.keys(body) : []
}

export function isAtoaSubscribedEvent(eventType: string | null): boolean {
  return !!eventType && (ATOA_SUBSCRIBED_EVENTS as readonly string[]).includes(eventType)
}

// Refund deliveries are subscribed to (the endpoint registration asks for all
// three of our event types, and a subscription cannot be narrowed afterwards
// without deleting and recreating the endpoint) but there is nothing for this
// release to do with one: refunds are recorded in the shop and the money is
// sent from the owner's own bank. Skipped rather than settled, so a refund
// notification does not send this module off to re-read a payment that has not
// changed. See refundOrder in lib/provider.ts.
export function isAtoaRefundEvent(eventType: string | null): boolean {
  return eventType === 'REFUND_STATUS'
}

export type AtoaWebhookAssessment = {
  references: AtoaWebhookReference[]
  eventTypes: string[]
  bodyKeys: string[]
  /**
   * True when this delivery yielded no payment reference AND should have.
   *
   * The route answers 500 on it, so Atoa retries - back-off for 24 hours, then
   * an email to the business owner - rather than the delivery disappearing.
   *
   * This is the guard on the one assumption in this file. The envelope is a
   * guess: if the identifier turns out to live under a key that is not
   * `paymentRequestId` or `orderId`, or deeper than MAX_DEPTH, then without
   * this every genuine payment notification on the shop would be swallowed in
   * silence and answered 200. The shopper pays, closes the tab, gets no order;
   * the owner gets no email; there is nothing in the logs to look at. Atoa's
   * retry is the only second chance there is and a 200 spends it.
   *
   * A delivery with an identifier is understood, whether or not the payment
   * turns out to be this shop's - somebody else's payment on a shared account
   * is a fact, not a failure. A delivery of an event we do not subscribe to,
   * which may legitimately carry no identifier, is understood too and answers
   * 200 (still logged). A body with no readable event type at all is NOT
   * understood: an unreadable body on a payment webhook is not a success.
   */
  unreadable: boolean
}

export function assessAtoaWebhookBody(body: unknown): AtoaWebhookAssessment {
  const references = atoaWebhookReferences(body)
  const eventTypes = atoaWebhookEventTypes(body)
  return {
    references,
    eventTypes,
    bodyKeys: atoaWebhookBodyKeys(body),
    unreadable:
      references.length === 0 &&
      // No event type to go on is itself the failure - see the note above.
      (eventTypes.length === 0 || eventTypes.some(isAtoaSubscribedEvent)),
  }
}
