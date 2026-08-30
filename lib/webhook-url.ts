// Where Atoa should send this site's webhooks.
//
// Built in one place because three things need to agree on it exactly: the
// route that registers the endpoint, the status route that decides whether an
// endpoint is already registered (by comparing URLs), and the settings tab that
// shows the owner what was registered. Atoa cannot edit an endpoint's URL after
// it is created - it has to be deleted and made again - so a URL that differs
// by a trailing slash is not a small problem.
export const ATOA_WEBHOOK_PATH = '/api/m/pay-with-atoa-for-shop/webhook'

export function atoaWebhookUrl(siteUrl: string): string {
  return `${siteUrl.replace(/\/+$/, '')}${ATOA_WEBHOOK_PATH}`
}

/** Whether Atoa could actually reach this URL.
 *
 *  A developer machine cannot be called back, and Atoa registering an endpoint
 *  it can never deliver to is worse than refusing: the endpoint counts against
 *  the limit of three per event type, and cannot be edited afterwards. */
export function isReachableWebhookUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1') return false
  // A hostname with no dot in it is a machine on somebody's own network, not a
  // site on the internet.
  return host.includes('.')
}
