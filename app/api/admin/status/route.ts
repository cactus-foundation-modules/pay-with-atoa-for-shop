// GET /api/m/pay-with-atoa-for-shop/admin/status
// Reports whether the credentials for the LIVE environment are set, whether
// Atoa accepts them, and whether this site's webhook endpoint is registered.
//
// Credentials are reported one at a time rather than as a single "configured"
// flag, so the panel can name what is actually missing. Telling an owner to add
// two things when one of them is already in - while showing "(set)" beside it -
// is how a working setup reads as a broken one.
import { NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { requireShopUser } from '@/modules/shop/lib/access'
import { getAtoaCredentials, isAtoaConfigured } from '@/modules/pay-with-atoa-for-shop/lib/env'
import { getAtoaSettings } from '@/modules/pay-with-atoa-for-shop/lib/settings'
import { listWebhookEndpoints, verifyCredentials } from '@/modules/pay-with-atoa-for-shop/lib/atoa'
import { atoaWebhookUrl } from '@/modules/pay-with-atoa-for-shop/lib/webhook-url'

export async function GET() {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const settings = await getAtoaSettings()
  const { environment } = settings
  const creds = getAtoaCredentials(environment)
  const base = {
    environment,
    accessSecretSet: !!creds.accessSecret,
    // Doubles as the V2-signing gate: Atoa only issues a `whsec_` secret once
    // the owner has turned V2 webhook signing on in the dashboard, so no secret
    // means unsigned webhooks and a method that cannot confirm its own
    // payments.
    webhookSigningSecretSet: !!creds.webhookSigningSecret,
    webhookUrl: atoaWebhookUrl(getSiteUrl()),
    storedWebhookEndpointId: settings.webhookEndpointId,
  }

  if (!isAtoaConfigured(environment)) {
    return NextResponse.json({ ...base, configured: false })
  }

  try {
    await verifyCredentials(environment)
  } catch (err) {
    return NextResponse.json({
      ...base,
      configured: true,
      connected: false,
      error: err instanceof Error ? err.message : 'Connection failed',
    })
  }

  // Asked separately, and allowed to fail on its own. Whether Atoa is talking
  // to this shop at all and whether a webhook endpoint has been registered are
  // two different questions, and a shop whose payments work perfectly well
  // should not be told it is disconnected because a second call fell over.
  try {
    const endpoints = await listWebhookEndpoints(environment)
    const registered = endpoints.find((e) => e.url === base.webhookUrl) ?? null
    return NextResponse.json({
      ...base,
      configured: true,
      connected: true,
      webhookRegistered: !!registered,
      webhookEndpointId: registered?.id ?? null,
      webhookEvents: registered?.events ?? [],
    })
  } catch (err) {
    return NextResponse.json({
      ...base,
      configured: true,
      connected: true,
      webhookError: err instanceof Error ? err.message : 'Could not read the webhook endpoints',
    })
  }
}
