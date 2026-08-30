// This module's own two tables. Raw SQL rather than Prisma models, like every
// other module: the schema is created by migrations/, not by core's client.
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'

export type AtpPayment = {
  id: string
  orderId: string
  orderNumber: string
  paymentRequestId: string | null
  paymentUrl: string | null
  status: string
  // A decimal string, for the same reason ShpOrder.total is one - it comes out
  // of NUMERIC(12,2), and the two are compared by the same code.
  amount: string
  currency: string
  returnPath: string | null
  createdAt: Date
}

function mapPayment(r: Record<string, unknown>): AtpPayment {
  return {
    id: r.id as string,
    orderId: r.order_id as string,
    orderNumber: r.order_number as string,
    paymentRequestId: (r.payment_request_id as string | null) ?? null,
    paymentUrl: (r.payment_url as string | null) ?? null,
    status: r.status as string,
    amount: (r.amount as { toString(): string }).toString(),
    currency: r.currency as string,
    returnPath: (r.return_path as string | null) ?? null,
    createdAt: r.created_at as Date,
  }
}

export async function createAtpPayment(input: {
  orderId: string
  orderNumber: string
  paymentRequestId: string
  paymentUrl: string
  amount: number
  currency: string
  status?: string
  returnPath?: string | null
}): Promise<AtpPayment> {
  const id = randomUUID()
  await prisma.$executeRaw`
    INSERT INTO "atp_payments" (
      "id", "order_id", "order_number", "payment_request_id", "payment_url",
      "status", "amount", "currency", "return_path", "created_at", "updated_at"
    ) VALUES (
      ${id}, ${input.orderId}, ${input.orderNumber}, ${input.paymentRequestId}, ${input.paymentUrl},
      ${input.status ?? 'PAYMENT_NOT_INITIATED'}, ${input.amount}, ${input.currency}, ${input.returnPath ?? null},
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `
  const row = await getAtpPaymentById(id)
  if (!row) throw new Error('Failed to create atp_payments row')
  return row
}

export async function getAtpPaymentById(id: string): Promise<AtpPayment | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "atp_payments" WHERE "id" = ${id} LIMIT 1
  `
  const row = rows[0]
  return row ? mapPayment(row) : null
}

/** The most recent attempt against this order. There can be more than one: a
 *  shopper who lets a payment link expire and comes back gets a fresh request. */
export async function getAtpPaymentByOrderId(orderId: string): Promise<AtpPayment | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "atp_payments" WHERE "order_id" = ${orderId} ORDER BY "created_at" DESC LIMIT 1
  `
  const row = rows[0]
  return row ? mapPayment(row) : null
}

export async function getAtpPaymentByPaymentRequestId(paymentRequestId: string): Promise<AtpPayment | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "atp_payments" WHERE "payment_request_id" = ${paymentRequestId} LIMIT 1
  `
  const row = rows[0]
  return row ? mapPayment(row) : null
}

export async function updateAtpPayment(id: string, patch: { status?: string; paymentUrl?: string }): Promise<void> {
  if (patch.status !== undefined) {
    await prisma.$executeRaw`UPDATE "atp_payments" SET "status" = ${patch.status}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = ${id}`
  }
  if (patch.paymentUrl !== undefined) {
    await prisma.$executeRaw`UPDATE "atp_payments" SET "payment_url" = ${patch.paymentUrl}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = ${id}`
  }
}

// --- Refunds ----------------------------------------------------------------
//
// UNREACHABLE IN THIS RELEASE, AND DELIBERATELY KEPT. Atoa's refund endpoints
// are switched off at the account level, so the module records refunds and the
// owner sends the money from their own bank (`refundMode: 'manual'`). Nothing
// reads or writes atp_refunds today. The claim lock below is the idempotency
// guard Atoa does not give us and is the whole reason this is worth keeping -
// see the note above the refund functions in lib/atoa.ts.

export type AtpRefund = {
  id: string
  paymentRequestId: string
  atoaRefundId: string | null
  amount: string
  currency: string
  status: string
}

function mapRefund(r: Record<string, unknown>): AtpRefund {
  return {
    id: r.id as string,
    paymentRequestId: r.payment_request_id as string,
    atoaRefundId: (r.atoa_refund_id as string | null) ?? null,
    amount: (r.amount as { toString(): string }).toString(),
    currency: r.currency as string,
    status: r.status as string,
  }
}

/**
 * Claim this refund, once.
 *
 * The row IS the lock, and it goes in BEFORE the call to Atoa - which offers no
 * idempotency mechanism of its own on refunds (nor on payments: the standard
 * Idempotency-Key header is ignored and a repeated orderId simply makes a second
 * payment request). The id is the shop's own refund row id, so a retried or
 * double-submitted refund finds the row already there.
 *
 * Returns true when this call is the one that claimed it, false when somebody
 * got there first - in which case no money must be sent.
 */
export async function claimAtpRefund(input: {
  refundRowId: string
  paymentRequestId: string
  amount: number
  currency: string
}): Promise<boolean> {
  // ON CONFLICT DO NOTHING rather than catching a unique-violation: the count
  // is an answer, whereas the shape of a driver's error is a guess.
  const inserted = await prisma.$executeRaw`
    INSERT INTO "atp_refunds" ("id", "payment_request_id", "amount", "currency", "status", "created_at", "updated_at")
    VALUES (${input.refundRowId}, ${input.paymentRequestId}, ${input.amount}, ${input.currency}, 'INITIATED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING
  `
  return inserted > 0
}

export async function getAtpRefundById(id: string): Promise<AtpRefund | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "atp_refunds" WHERE "id" = ${id} LIMIT 1
  `
  const row = rows[0]
  return row ? mapRefund(row) : null
}

/** Every refund this module has sent against a payment, failures included. What
 *  is still refundable is worked out from these rather than from Atoa's own
 *  totals, which this module has never been able to see. */
export async function listAtpRefundsByPaymentRequestId(paymentRequestId: string): Promise<AtpRefund[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "atp_refunds" WHERE "payment_request_id" = ${paymentRequestId} ORDER BY "created_at" ASC
  `
  return rows.map(mapRefund)
}

export async function updateAtpRefund(id: string, patch: { atoaRefundId?: string; status?: string }): Promise<void> {
  if (patch.atoaRefundId !== undefined) {
    await prisma.$executeRaw`UPDATE "atp_refunds" SET "atoa_refund_id" = ${patch.atoaRefundId}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = ${id}`
  }
  if (patch.status !== undefined) {
    await prisma.$executeRaw`UPDATE "atp_refunds" SET "status" = ${patch.status}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = ${id}`
  }
}

export async function deleteAtpRefund(id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "atp_refunds" WHERE "id" = ${id}`
}
