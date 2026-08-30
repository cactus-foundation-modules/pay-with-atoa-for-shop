// GET/PATCH /api/m/pay-with-atoa-for-shop/admin/settings
// Non-secret module settings: the on/off toggle, the payment reference shown to
// the payer, which of Atoa's two environments the shop takes payments in, how
// long a payment link lives, where the shopper authorises the payment, and
// whether cards are offered alongside pay-by-bank. The credentials themselves are environment variables and go
// nowhere near this route.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import {
  getAtoaSettings,
  updateAtoaSettings,
  MAX_EXPIRES_IN_MINUTES,
  MAX_PAYMENT_DESCRIPTION_LENGTH,
  MIN_EXPIRES_IN_MINUTES,
} from '@/modules/pay-with-atoa-for-shop/lib/settings'

export async function GET() {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error
  return NextResponse.json(await getAtoaSettings())
}

const PatchBody = z.object({
  enabled: z.boolean().optional(),
  // Atoa rejects a `notes` value over 30 characters outright, so the same limit
  // is the one enforced here. Refused rather than trimmed: a description that
  // came back a word shorter than it was typed reads as a bug, and the settings
  // tab counts the owner down to this number so it should never arrive.
  paymentDescription: z.string().max(MAX_PAYMENT_DESCRIPTION_LENGTH).optional(),
  // Stored rather than an env var, so switching between test and real money
  // takes effect on the next request instead of the next deployment.
  environment: z.enum(['sandbox', 'production']).optional(),
  // Hosted redirect or the on-page dialog. A closed set rather than a free
  // string: the column carries a CHECK constraint of exactly these two, so
  // anything else is a 500 from the database instead of a 400 from here.
  paymentEntry: z.enum(['redirect', 'on-page']).optional(),
  expiresInMinutes: z.number().int().min(MIN_EXPIRES_IN_MINUTES).max(MAX_EXPIRES_IN_MINUTES).optional(),
  allowCard: z.boolean().optional(),
  // `webhookEndpointId` is deliberately NOT settable here. It is Atoa's own id
  // for an endpoint that either exists or does not, and letting it be typed in
  // would let the panel claim a registration that was never made.
})

export async function PATCH(request: NextRequest) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const parsed = PatchBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid settings' }, { status: 400 })

  const settings = await updateAtoaSettings(parsed.data)
  return NextResponse.json(settings)
}
