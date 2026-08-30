// POST /api/m/pay-with-atoa-for-shop/admin/register-webhook
// Registers this site's webhook endpoint with Atoa and remembers its id.
//
// Atoa registers endpoints over its own API rather than having the owner paste
// a URL into somebody else's dashboard, which is a good deal better than the
// alternative - so this is a button rather than a set of instructions. Three
// things about Atoa's endpoints shape what happens here: a URL cannot be edited
// once created (delete and recreate), there is a hard limit of three endpoints
// per event type, and the signing secret is NOT returned by this call - it is
// generated separately in the dashboard, which is why it is an environment
// variable.
import { NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { requireShopUser } from '@/modules/shop/lib/access'
import { isAtoaConfigured } from '@/modules/pay-with-atoa-for-shop/lib/env'
import { getAtoaSettings, updateAtoaSettings } from '@/modules/pay-with-atoa-for-shop/lib/settings'
import { createWebhookEndpoint, listWebhookEndpoints } from '@/modules/pay-with-atoa-for-shop/lib/atoa'
import { atoaWebhookUrl, isReachableWebhookUrl } from '@/modules/pay-with-atoa-for-shop/lib/webhook-url'

export async function POST() {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const { environment } = await getAtoaSettings()
  if (!isAtoaConfigured(environment)) {
    return NextResponse.json(
      { error: `Add the ${environment} access secret and webhook signing secret first.` },
      { status: 400 },
    )
  }

  const url = atoaWebhookUrl(getSiteUrl())
  if (!isReachableWebhookUrl(url)) {
    return NextResponse.json(
      { error: `Atoa cannot deliver to ${url}. Register the webhook from the live site rather than a development machine.` },
      { status: 400 },
    )
  }

  try {
    // Looked up first rather than simply created. Registering the same URL
    // twice would spend two of the three endpoints Atoa allows per event type
    // on one site, and neither could be edited afterwards - so an endpoint that
    // is already there is adopted instead.
    const existing = (await listWebhookEndpoints(environment)).find((e) => e.url === url)
    const endpoint = existing ?? (await createWebhookEndpoint(environment, {
      url,
      description: 'Cactus shop - payment confirmations',
    }))
    await updateAtoaSettings({ webhookEndpointId: endpoint.id })
    return NextResponse.json({
      endpoint,
      // So the panel can say "you already had one" rather than claim it made
      // something it did not.
      alreadyRegistered: !!existing,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Atoa refused the webhook registration' },
      { status: 502 },
    )
  }
}
