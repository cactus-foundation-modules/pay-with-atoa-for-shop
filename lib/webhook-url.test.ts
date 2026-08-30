import { describe, expect, it } from 'vitest'
import { atoaWebhookUrl, isReachableWebhookUrl } from '@/modules/pay-with-atoa-for-shop/lib/webhook-url'

describe('atoaWebhookUrl', () => {
  it('builds the module route off the site URL', () => {
    expect(atoaWebhookUrl('https://example.com')).toBe('https://example.com/api/m/pay-with-atoa-for-shop/webhook')
  })

  // Atoa cannot edit an endpoint's URL after it is created - it has to be
  // deleted and made again - so a trailing slash making two different URLs is
  // not a small problem.
  it('does not double the slash on a site URL that ends in one', () => {
    expect(atoaWebhookUrl('https://example.com/')).toBe('https://example.com/api/m/pay-with-atoa-for-shop/webhook')
  })
})

describe('isReachableWebhookUrl', () => {
  it('accepts a real site', () => {
    expect(isReachableWebhookUrl('https://example.com/api/m/pay-with-atoa-for-shop/webhook')).toBe(true)
  })

  // Registering an endpoint Atoa can never deliver to is worse than refusing:
  // it counts against the limit of three per event type and cannot be edited.
  it('refuses a development machine', () => {
    expect(isReachableWebhookUrl('http://localhost:3000/api/m/pay-with-atoa-for-shop/webhook')).toBe(false)
    expect(isReachableWebhookUrl('https://localhost:3000/x')).toBe(false)
    expect(isReachableWebhookUrl('https://127.0.0.1/x')).toBe(false)
    expect(isReachableWebhookUrl('https://my-laptop/x')).toBe(false)
  })

  it('refuses plain http and anything that is not a URL', () => {
    expect(isReachableWebhookUrl('http://example.com/x')).toBe(false)
    expect(isReachableWebhookUrl('not a url')).toBe(false)
    expect(isReachableWebhookUrl('')).toBe(false)
  })
})
