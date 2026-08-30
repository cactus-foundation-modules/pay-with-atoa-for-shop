// This module's own settings: the on/off toggle, the payment reference, which
// of the two Atoa environments the shop takes payments in, how long a payment
// link lives, whether cards are offered alongside pay-by-bank, and the id of
// the webhook endpoint registered with Atoa.
//
// The environment lives here rather than in an ATOA_ENVIRONMENT variable
// because an environment variable on a hosted project does not reach the
// running server until the next deployment. Choosing "Production" therefore did
// nothing until a redeploy, and the settings panel - reading back the
// environment the server could actually see - snapped the dropdown straight
// back to Sandbox, which looked for all the world like the save had failed. A
// stored setting takes effect on the very next request. (The same lesson the
// Square module learned; see its lib/settings.ts.)
//
// The credentials themselves stay in environment variables, because they are
// secrets and the database is included in backups.
import { prisma } from '@/lib/db/prisma'

export type AtoaEnvironment = 'production' | 'sandbox'

// Where the shopper authorises the payment.
//
//  'redirect' - handed to Atoa's own hosted page and brought back afterwards.
//  'on-page'  - Atoa's dialog opens over this site's own checkout, which needs
//               the site's domain whitelisted in the Atoa dashboard first.
//
// The two are mutually exclusive by design: an intent carries an approvalUrl or
// it carries clientFields, never both, because those are two contradictory
// instructions to the checkout (see lib/intent.ts).
export type AtoaPaymentEntry = 'redirect' | 'on-page'

// Sandbox and production share one API host (api.atoa.me); which environment a
// call lands in is decided by the key it is made with. So getting this wrong is
// not a connection error, it is real money moving - hence the safe fallback
// below and the unmissable label the settings tab gives it.
const FALLBACK_ENVIRONMENT: AtoaEnvironment = 'sandbox'

// Redirect, and not merely as a tidy default. The on-page dialog only loads on
// a domain whitelisted in the Atoa dashboard, and no existing shop has been
// asked to do that - so an unrecognised or missing value reading as 'on-page'
// would switch a working payment method off on somebody's live shop the moment
// they updated the module. The redirect path needs nothing of anybody.
const FALLBACK_PAYMENT_ENTRY: AtoaPaymentEntry = 'redirect'

// How long an Atoa payment link stays alive, in minutes.
//
// Clamped rather than trusted: Atoa accepts expiresIn values of 0 and -1
// without complaint (proved in sandbox), so a shop owner who types 0 would get
// a payment link that is dead on arrival and no error to explain it. The floor
// is the shortest span in which somebody could plausibly open a banking app and
// approve; the ceiling keeps an abandoned link from outliving the basket it
// belongs to by weeks.
export const MIN_EXPIRES_IN_MINUTES = 5
export const MAX_EXPIRES_IN_MINUTES = 1440

// Atoa rejects a payment `notes` value over 30 characters outright (proved:
// 31 characters returns 400). Exported so the settings tab can count down to it
// rather than have the API refuse the save.
export const MAX_PAYMENT_DESCRIPTION_LENGTH = 30

export type AtoaSettings = {
  enabled: boolean
  // The reference the payer sees against the payment. Capped at
  // MAX_PAYMENT_DESCRIPTION_LENGTH, which is Atoa's own limit.
  paymentDescription: string
  environment: AtoaEnvironment
  // Hosted redirect, or the on-page dialog. See AtoaPaymentEntry.
  paymentEntry: AtoaPaymentEntry
  expiresInMinutes: number
  // Whether Atoa is allowed to offer cards as well as pay-by-bank.
  allowCard: boolean
  // The webhook endpoint this site registered with Atoa, if it has. Atoa
  // registers endpoints over the API rather than having the owner paste a URL
  // into a dashboard, so the id is ours to keep.
  webhookEndpointId: string | null
}

const FALLBACK: AtoaSettings = {
  enabled: false,
  paymentDescription: '',
  environment: FALLBACK_ENVIRONMENT,
  paymentEntry: FALLBACK_PAYMENT_ENTRY,
  expiresInMinutes: 30,
  allowCard: false,
  webhookEndpointId: null,
}

// Anything unrecognised reads as sandbox - see FALLBACK_ENVIRONMENT. Never
// `undefined as AtoaEnvironment`: this row can predate a migration by a deploy
// or two, and a cast would hand the API client an environment that is neither.
function toEnvironment(stored: unknown): AtoaEnvironment {
  return stored === 'production' || stored === 'sandbox' ? stored : FALLBACK_ENVIRONMENT
}

// Anything unrecognised reads as 'redirect' - see FALLBACK_PAYMENT_ENTRY. That
// covers a row written before this column existed as well as a value from a
// future version of this module that this one has never heard of.
export function toPaymentEntry(stored: unknown): AtoaPaymentEntry {
  return stored === 'on-page' || stored === 'redirect' ? stored : FALLBACK_PAYMENT_ENTRY
}

export function clampExpiresInMinutes(stored: unknown): number {
  // A NULL column, a blank box or anything that is not a number at all falls
  // back to the default rather than being clamped. Number(null) is 0, which is
  // perfectly finite and would otherwise clamp a missing value to the FLOOR -
  // so a row written before this column existed would quietly hand every shop
  // the shortest expiry on offer instead of the sensible one.
  if (typeof stored !== 'number' && typeof stored !== 'string') return FALLBACK.expiresInMinutes
  if (typeof stored === 'string' && stored.trim() === '') return FALLBACK.expiresInMinutes
  const minutes = Math.round(Number(stored))
  if (!Number.isFinite(minutes)) return FALLBACK.expiresInMinutes
  return Math.min(MAX_EXPIRES_IN_MINUTES, Math.max(MIN_EXPIRES_IN_MINUTES, minutes))
}

export function clampPaymentDescription(stored: unknown): string {
  return typeof stored === 'string' ? stored.trim().slice(0, MAX_PAYMENT_DESCRIPTION_LENGTH) : ''
}

export async function getAtoaSettings(): Promise<AtoaSettings> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "atp_settings" WHERE "id" = 'singleton' LIMIT 1
  `
  const r = rows[0]
  if (!r) return FALLBACK
  return {
    enabled: r.enabled === true,
    paymentDescription: clampPaymentDescription(r.payment_description),
    environment: toEnvironment(r.environment),
    paymentEntry: toPaymentEntry(r.payment_entry),
    expiresInMinutes: clampExpiresInMinutes(r.expires_in_minutes),
    allowCard: r.allow_card === true,
    webhookEndpointId: (r.webhook_endpoint_id as string | null) ?? null,
  }
}

// Convenience for the code paths that only care which environment is live.
export async function getAtoaEnvironment(): Promise<AtoaEnvironment> {
  return (await getAtoaSettings()).environment
}

export async function updateAtoaSettings(input: Partial<AtoaSettings>): Promise<AtoaSettings> {
  const current = await getAtoaSettings()
  const merged: AtoaSettings = {
    ...current,
    ...input,
    // Clamped on the way in as well as on the way out, so a bad value never
    // reaches the row in the first place.
    paymentDescription: clampPaymentDescription(input.paymentDescription ?? current.paymentDescription),
    paymentEntry: toPaymentEntry(input.paymentEntry ?? current.paymentEntry),
    expiresInMinutes: clampExpiresInMinutes(input.expiresInMinutes ?? current.expiresInMinutes),
  }
  await prisma.$executeRaw`
    INSERT INTO "atp_settings" ("id", "enabled", "payment_description", "environment", "payment_entry", "expires_in_minutes", "allow_card", "webhook_endpoint_id", "updated_at")
    VALUES ('singleton', ${merged.enabled}, ${merged.paymentDescription}, ${merged.environment}, ${merged.paymentEntry}, ${merged.expiresInMinutes}, ${merged.allowCard}, ${merged.webhookEndpointId}, CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO UPDATE SET
      "enabled" = ${merged.enabled},
      "payment_description" = ${merged.paymentDescription},
      "environment" = ${merged.environment},
      "payment_entry" = ${merged.paymentEntry},
      "expires_in_minutes" = ${merged.expiresInMinutes},
      "allow_card" = ${merged.allowCard},
      "webhook_endpoint_id" = ${merged.webhookEndpointId},
      "updated_at" = CURRENT_TIMESTAMP
  `
  return getAtoaSettings()
}
