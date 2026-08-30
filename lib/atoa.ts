// Thin Atoa REST client. No SDK dependency - the handful of payment, refund and
// webhook-endpoint calls this module needs are plain REST.
//
// Auth is `Authorization: Bearer <accessSecret>`: the access secret IS the
// token. There is no exchange endpoint, no token lifetime and nothing to
// refresh, and the access id that comes with it plays no part (sending it as a
// bearer token is a 401). One host serves both environments; which one a call
// lands in is decided by the key it carries.
//
// Every response is narrowed to a declared shape before it leaves this file.
// Nothing downstream sees `unknown`, and nothing here guesses: a field that is
// not the shape it should be throws, because a payment client that quietly
// invents a value it could not read is how a shop ends up fulfilling an order
// against money nobody sent.
//
// Reference: docs.paywithatoa.co.uk. Where the documentation and the sandbox
// disagreed, the sandbox won - the endpoint paths and defaults below were each
// called for real.
import { ATOA_API_BASE, getAtoaAccessSecret, type AtoaEnvironment } from '@/modules/pay-with-atoa-for-shop/lib/env'
import { parseAtoaPaymentStatus, parseAtoaRefundStatus, type AtoaPaymentStatus, type AtoaRefundStatus } from '@/modules/pay-with-atoa-for-shop/lib/status'
import { ATOA_CURRENCY, roundToPennies } from '@/modules/pay-with-atoa-for-shop/lib/amount'

const REQUEST_TIMEOUT_MS = 20_000

// --- Narrowing helpers ------------------------------------------------------

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Atoa returned something other than an object for ${context}`)
  }
  return value as Record<string, unknown>
}

function readString(source: Record<string, unknown>, key: string, context: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Atoa's ${context} response is missing "${key}"`)
  }
  return value
}

function readOptionalString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

// Atoa sends amounts as JSON numbers, but a decimal arriving as a string is a
// perfectly ordinary thing for a payments API to do and would otherwise read as
// "no amount at all" - which on the settlement path means a matched payment
// silently failing its own amount check.
function readOptionalAmount(source: Record<string, unknown>, key: string): number | null {
  const value = source[key]
  if (typeof value === 'number') return Number.isFinite(value) ? roundToPennies(value) : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? roundToPennies(parsed) : null
  }
  return null
}

// --- Transport --------------------------------------------------------------

type AtoaFetchInit = { method?: string; body?: unknown; query?: Record<string, string> }

async function atoaFetch(environment: AtoaEnvironment, path: string, init: AtoaFetchInit = {}): Promise<unknown> {
  const secret = getAtoaAccessSecret(environment)
  if (!secret) throw new Error('Atoa is not configured')

  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    Accept: 'application/json',
  }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'

  const query = init.query ? `?${new URLSearchParams(init.query).toString()}` : ''
  const res = await fetch(`${ATOA_API_BASE}${path}${query}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!res.ok) {
    // Atoa's errors are `{ name, message, status, errors }` and its messages are
    // decent enough English to be worth passing on ("Amount must not be less
    // than 1.", "Payment notes must not exceed 30 characters.").
    const detail = await res.json().catch(() => null)
    const message = typeof detail === 'object' && detail !== null && typeof (detail as { message?: unknown }).message === 'string'
      ? (detail as { message: string }).message
      : `Atoa API error ${res.status}`
    throw new Error(message)
  }
  return res.json()
}

// --- Payment requests -------------------------------------------------------

export type AtoaPaymentRequest = {
  paymentRequestId: string
  // Atoa's own hosted page, where the shopper picks their bank and approves.
  paymentUrl: string
}

// Everything Atoa is told about a payment at creation. `metadata` is frozen the
// moment the request exists and cannot be amended afterwards, so anything
// needed for reconciliation goes in now - though our own atp_payments row is
// the source of truth regardless.
export type CreatePaymentRequestInput = {
  // Our reference, echoed back on the status call and in webhooks. The shop's
  // order (or draft) id, because that is what the settlement path looks up by.
  orderId: string
  // Major units. Rounded to two places here: Atoa truncates a third rather than
  // rounding it, which would undercharge by up to a penny and then fail the
  // settlement path's own amount re-check.
  amount: number
  // Atoa's reference for the payer. Not a Cactus member id - just something
  // stable to group a person's payments by on Atoa's side.
  customerId: string
  redirectUrl: string
  expiresInMs: number
  // Capped at 30 characters by Atoa, and rejected outright above it.
  notes?: string
  consumer?: { email?: string; firstName?: string; lastName?: string }
  // Whether Atoa may offer cards alongside pay-by-bank.
  allowCard: boolean
}

export async function createPaymentRequest(
  environment: AtoaEnvironment,
  input: CreatePaymentRequestInput,
): Promise<AtoaPaymentRequest> {
  const consumerDetails = input.consumer
    ? Object.fromEntries(Object.entries(input.consumer).filter(([, v]) => !!v))
    : {}

  const data = await atoaFetch(environment, '/api/payments/process-payment', {
    method: 'POST',
    body: {
      orderId: input.orderId,
      amount: roundToPennies(input.amount),
      customerId: input.customerId,
      redirectUrl: input.redirectUrl,
      // Always sent explicitly. Atoa's own default is three minutes, which is
      // nowhere near long enough to open a banking app and approve, and would
      // produce dead payment links as routine behaviour.
      expiresIn: input.expiresInMs,
      // Off, and sent explicitly because it defaults to TRUE. A tip prompt on a
      // shop checkout is nobody's idea of a good time, and worse than that:
      // tipAmount sits OUTSIDE paidAmount, so a tipped payment would arrive
      // with a total that legitimately disagrees with the order and the
      // settlement path's mismatch guard would fire on a perfectly good
      // payment.
      enableTips: false,
      // Pay-by-bank only unless the owner has turned cards on. When they have,
      // the field is left off entirely rather than filled in with a guess:
      // omitting it lets Atoa offer whatever the merchant account is set up
      // for, which is the whole point of the setting.
      ...(input.allowCard ? {} : { paymentMethod: ['PAY_BY_BANK'] }),
      ...(input.notes ? { notes: input.notes } : {}),
      ...(Object.keys(consumerDetails).length > 0 ? { consumerDetails } : {}),
      // NOT sent: `currency`. Atoa accepts the field and ignores it completely -
      // USD, EUR and even a made-up code all rendered as pounds - so sending it
      // would imply a control that does not exist. GBP is refused upstream
      // instead (see lib/amount.ts and the provider's createIntent).
    },
  })

  const record = asRecord(data, 'the payment request')
  return {
    paymentRequestId: readString(record, 'paymentRequestId', 'create payment'),
    paymentUrl: readString(record, 'paymentUrl', 'create payment'),
  }
}

export type AtoaPaymentStatusResult = {
  paymentRequestId: string
  status: AtoaPaymentStatus
  // The amount actually paid, in major units. Null until somebody has paid:
  // the status response for an untouched request carries no amount field at
  // all. This is the figure the settlement path re-checks against the order -
  // NOT any tip, which Atoa reports separately and which is why tips are off.
  paidAmount: number | null
  currency: string
}

export async function getPaymentStatus(
  environment: AtoaEnvironment,
  paymentRequestId: string,
): Promise<AtoaPaymentStatusResult> {
  const data = await atoaFetch(
    environment,
    `/api/payments/v1/payment-status/${encodeURIComponent(paymentRequestId)}`,
    {
      // The one call that documents an `env` parameter, and the one whose
      // default is production. It made no observable difference in sandbox, but
      // a status call that silently answered from the wrong environment is
      // exactly the class of bug that goes unnoticed, so it is sent.
      ...(environment === 'sandbox' ? { query: { env: 'sandbox' } } : {}),
    },
  )

  const record = asRecord(data, 'the payment status')
  return {
    // Echoed back by Atoa; fall back to what we asked about rather than throw,
    // since the id is the one thing here we already know for certain.
    paymentRequestId: readOptionalString(record, 'paymentRequestId') ?? paymentRequestId,
    status: parseAtoaPaymentStatus(record.status),
    paidAmount: readOptionalAmount(record, 'paidAmount'),
    // Atoa is GBP-only and ignores the currency field on the way in, so a
    // response that omits it on the way out is saying pounds. Defaulted here
    // rather than in the settlement path, which has no business quietly
    // deciding what currency a payment was in.
    currency: readOptionalString(record, 'currency') ?? ATOA_CURRENCY,
  }
}

export async function cancelPayment(environment: AtoaEnvironment, paymentRequestId: string): Promise<void> {
  await atoaFetch(environment, `/api/payment-request/cancel/${encodeURIComponent(paymentRequestId)}`, { method: 'POST' })
}

// Cheap authenticated call used to check the access secret works. Throws on
// failure, which is what the admin status route wants.
export async function verifyCredentials(environment: AtoaEnvironment): Promise<void> {
  await atoaFetch(environment, '/api/payments/stores')
}

// --- Refunds ----------------------------------------------------------------
//
// UNREACHABLE IN THIS RELEASE, AND DELIBERATELY KEPT.
//
// Refunds are provisioned per merchant account, and on an account without them
// both calls below answer 405 with "Refunds are not available for this account.
// Please contact support." Rather than ship a Refund button that collects a 405
// and reads as a broken Cactus, the provider declares `refundMode: 'manual'`
// and refunds are recorded here and sent from the owner's own bank - see
// refundOrder in lib/provider.ts.
//
// So NOTHING CALLS THE THREE FUNCTIONS BELOW. They are kept, with their tests,
// because the work is wanted the moment Atoa enable the account: turning
// refunds back on is then a provider change and not a rebuild. Do not delete
// them, and do not wire them up without checking the account first.
//
// DOCUMENTED, NOT PROVED. The request and response shapes come from Atoa's
// documentation and have never been seen for real, which is why the reader is
// forgiving about where it finds a refund and reports "could not tell" rather
// than guessing.

export type AtoaRefund = {
  refundId: string
  status: AtoaRefundStatus
}

export async function initiateRefund(
  environment: AtoaEnvironment,
  input: { paymentRequestId: string; amount: number; notes?: string },
): Promise<{ refundId: string }> {
  const data = await atoaFetch(environment, '/api/refund', {
    method: 'POST',
    body: {
      paymentRequestId: input.paymentRequestId,
      amount: roundToPennies(input.amount),
      // Optional, and defaults to the original transaction's currency. Sent
      // here because it IS a real field on this call, unlike on create.
      currency: ATOA_CURRENCY,
      ...(input.notes ? { refundNotes: input.notes } : {}),
    },
  })

  const record = asRecord(data, 'the refund')
  return { refundId: readString(record, 'refundId', 'initiate refund') }
}

// The refunds Atoa holds against a payment. Returns an empty list when the
// response is not in a shape this module recognises, which a caller must read
// as "no answer" rather than "no refunds" - guessing in either direction about
// money already sent is worse than leaving the row for a human.
export async function listRefunds(environment: AtoaEnvironment, paymentRequestId: string): Promise<AtoaRefund[]> {
  const data = await atoaFetch(environment, `/api/refund/${encodeURIComponent(paymentRequestId)}`)

  const candidates: unknown[] = Array.isArray(data)
    ? data
    : (() => {
        const record = asRecord(data, 'the refund status')
        if (Array.isArray(record.data)) return record.data
        if (Array.isArray(record.refunds)) return record.refunds
        return [record]
      })()

  const refunds: AtoaRefund[] = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    const refundId = readOptionalString(record, 'refundId')
    if (!refundId || typeof record.status !== 'string') continue
    refunds.push({ refundId, status: parseAtoaRefundStatus(record.status) })
  }
  return refunds
}

// --- Webhook endpoints ------------------------------------------------------
//
// Atoa registers webhook endpoints over the API rather than having the owner
// paste a URL into somebody else's dashboard, which is a good deal better than
// the alternative. Three things about them that are not obvious: a URL cannot
// be edited once created (delete and recreate), there is a hard limit of three
// endpoints per event type, and the signing secret is NOT returned here - it is
// generated separately in the dashboard, which is why it is an env var.

// POS_PAYMENT_STATUS is deliberately absent: it is not ours.
export const ATOA_WEBHOOK_EVENTS = ['PAYMENTS_STATUS', 'EXPIRED_STATUS', 'REFUND_STATUS'] as const

export type AtoaWebhookEndpoint = {
  id: string
  url: string
  description: string | null
  events: string[]
}

function mapWebhookEndpoint(value: unknown): AtoaWebhookEndpoint {
  const record = asRecord(value, 'a webhook endpoint')
  const events = Array.isArray(record.events)
    ? record.events
        .map((e) => (typeof e === 'string' ? e : (typeof e === 'object' && e !== null ? readOptionalString(e as Record<string, unknown>, 'event') : null)))
        .filter((e): e is string => !!e)
    : []
  return {
    id: readString(record, 'id', 'webhook endpoint'),
    url: readString(record, 'url', 'webhook endpoint'),
    description: readOptionalString(record, 'description'),
    events,
  }
}

export async function createWebhookEndpoint(
  environment: AtoaEnvironment,
  input: { url: string; description: string },
): Promise<AtoaWebhookEndpoint> {
  const data = await atoaFetch(environment, '/api/webhook/v2/endpoints', {
    method: 'POST',
    body: {
      url: input.url,
      // Atoa caps this at 100 characters.
      description: input.description.slice(0, 100),
      events: [...ATOA_WEBHOOK_EVENTS],
    },
  })
  return mapWebhookEndpoint(data)
}

export async function listWebhookEndpoints(environment: AtoaEnvironment): Promise<AtoaWebhookEndpoint[]> {
  const data = await atoaFetch(environment, '/api/webhook/v2/endpoints')
  const record = asRecord(data, 'the webhook endpoint list')
  const rows = Array.isArray(record.data) ? record.data : []
  return rows.map(mapWebhookEndpoint)
}

export async function deleteWebhookEndpoint(environment: AtoaEnvironment, endpointId: string): Promise<void> {
  await atoaFetch(environment, `/api/webhook/v2/endpoints/${encodeURIComponent(endpointId)}`, { method: 'DELETE' })
}
