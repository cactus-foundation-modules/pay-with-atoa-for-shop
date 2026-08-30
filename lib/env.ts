// Atoa credentials, sourced from env vars (managed on the core admin settings
// page, like the Stripe/PayPal keys in shop). Nothing secret is stored in the
// database, because the database is included in backups.
//
// Sandbox and production credentials live in SEPARATE variables so both sets
// can be held at once and the environment choice actually swaps which set is
// live. Sharing one set meant a saved production key still read as "set" while
// the panel was showing sandbox, and switching environment silently pointed
// production credentials at the other environment.
//
// WHICH environment is live is deliberately not here: it is a stored setting
// (see lib/settings.ts) so it can be changed without a deployment. Every
// function below therefore takes the environment as an argument - there is no
// ambient "current" one to get wrong.
//
// There is no access-id variable, and that is not an oversight. Atoa's dashboard
// hands out an access id alongside the access secret, but the id plays no part
// in authentication: the secret IS the bearer token, and sending the id as one
// is rejected with 401 (proved against the sandbox API). A variable the module
// never reads is only a thing to get wrong.
import type { AtoaEnvironment } from '@/modules/pay-with-atoa-for-shop/lib/settings'

export type { AtoaEnvironment }

// One host for both environments. Which environment a call lands in is decided
// by the key it carries, not by the URL - Atoa reports it back unprompted (a
// webhook registration made with a sandbox key answers `environment: SANDBOX`).
// There is no separate sandbox host: devapi.atoa.me exists but rejects these
// keys, so it is not ours.
export const ATOA_API_BASE = 'https://api.atoa.me'

export type AtoaCredentialSet = {
  // The bearer token for every API call. Long-lived; there is no exchange
  // endpoint, no expiry and nothing to refresh.
  accessSecret: string | null
  // The V2 webhook signing secret, in Atoa's `whsec_<base64>` form exactly as
  // the dashboard shows it. Decoding is lib/webhook-signature.ts's job.
  webhookSigningSecret: string | null
}

// Production keeps the unprefixed names; sandbox gets its own set. Exported so
// the settings tab names exactly the variables read back here.
export function atoaEnvVarNames(environment: AtoaEnvironment) {
  return environment === 'sandbox'
    ? {
        accessSecret: 'ATOA_SANDBOX_ACCESS_SECRET',
        webhookSigningSecret: 'ATOA_SANDBOX_WEBHOOK_SIGNING_SECRET',
      }
    : {
        accessSecret: 'ATOA_ACCESS_SECRET',
        webhookSigningSecret: 'ATOA_WEBHOOK_SIGNING_SECRET',
      }
}

// Static process.env references on purpose - a computed `process.env[name]`
// lookup is not inlined by the bundler and reads as empty in some runtimes.
export function getAtoaCredentials(environment: AtoaEnvironment): AtoaCredentialSet {
  return environment === 'sandbox'
    ? {
        accessSecret: process.env.ATOA_SANDBOX_ACCESS_SECRET || null,
        webhookSigningSecret: process.env.ATOA_SANDBOX_WEBHOOK_SIGNING_SECRET || null,
      }
    : {
        accessSecret: process.env.ATOA_ACCESS_SECRET || null,
        webhookSigningSecret: process.env.ATOA_WEBHOOK_SIGNING_SECRET || null,
      }
}

export function getAtoaAccessSecret(environment: AtoaEnvironment): string | null {
  return getAtoaCredentials(environment).accessSecret
}

export function getAtoaWebhookSigningSecret(environment: AtoaEnvironment): string | null {
  return getAtoaCredentials(environment).webhookSigningSecret
}

// Both halves are required before the method may reach a checkout, and both for
// the environment that is actually live.
//
// The access secret is how a payment request gets created. The signing secret is
// how a webhook telling us the money arrived is believed - and it doubles as the
// gate on something less obvious: Atoa's V2 webhook signing is opt-in per
// merchant, and the `whsec_` secret only exists once the owner has turned it on.
// Without V2 the webhooks arrive unsigned in any useful sense (V1 signs two
// non-secret identifiers and sends no signature header at all), so a shop with
// no signing secret is a shop that cannot confirm its own payments. A payment
// method that cannot do that must not be offered.
export function isAtoaConfigured(environment: AtoaEnvironment): boolean {
  const creds = getAtoaCredentials(environment)
  return !!(creds.accessSecret && creds.webhookSigningSecret)
}
