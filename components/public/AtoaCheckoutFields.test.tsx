// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AtoaCheckoutFields } from '@/modules/pay-with-atoa-for-shop/components/public/AtoaCheckoutFields'
import { ATOA_MESSAGES } from '@/modules/pay-with-atoa-for-shop/components/public/atoa-messages'
import type { AtoaSdkOptions } from '@/modules/pay-with-atoa-for-shop/components/public/atoa-sdk'
import type { ShopCheckoutPayer } from '@/modules/shop/components/public/checkout-payment-fields'

// What happens to a payment this component is in the middle of when the
// component goes away.
//
// Atoa's dispose() removes the dialog and calls none of its callbacks - only
// the shopper's own close and cancel do that. So a component that disposed
// without settling left shop holding a promise that never resolved, its
// "placing the order" flag raised and "Place order" disabled for the rest of
// the page's life with nothing on screen to explain it.

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const payer: ShopCheckoutPayer = {
  email: 'shopper@example.com',
  name: 'A Shopper',
  address: {
    firstName: 'A', lastName: 'Shopper', line1: '1 Test Street', city: 'Leeds',
    postcode: 'LS1 1AA', country: 'GB',
  } as ShopCheckoutPayer['address'],
}

const config = { environment: 'SANDBOX', paymentRequestId: 'pr_test_1' }

let opened: AtoaSdkOptions[]
let disposed: number

// Stubbed on the window, which is also what makes loadAtoaSdk resolve without
// ever appending a script tag - there is no CDN in a test.
function installSdkStub() {
  opened = []
  disposed = 0
  class FakeSdk {
    constructor(readonly options: AtoaSdkOptions) { opened.push(options) }
    showPaymentDialog() {}
    dispose() { disposed += 1 }
  }
  window.AtoaPayWebSdk = { AtoaWebSdk: FakeSdk as unknown as NonNullable<typeof window.AtoaPayWebSdk>['AtoaWebSdk'] }
}

let container: HTMLDivElement
let root: Root
let submit: ((config: Record<string, unknown>) => Promise<unknown>) | null

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  submit = null
  await act(async () => {
    root.render(
      <AtoaCheckoutFields
        config={config}
        payer={payer}
        onError={() => {}}
        registerSubmit={(fn) => { submit = fn }}
      />,
    )
  })
}

beforeEach(() => {
  installSdkStub()
})

afterEach(() => {
  delete window.AtoaPayWebSdk
  container?.remove()
})

describe('AtoaCheckoutFields on unmount', () => {
  it('settles a payment it is still waiting on, rather than leaving Place order dead', async () => {
    await mount()
    expect(submit).toBeTypeOf('function')

    // The press. The dialog opens and nothing resolves it yet - the shopper is
    // in their banking app.
    let outcome: unknown = null
    const pending = submit!(config).then(
      (value) => { outcome = { resolved: value } },
      (err: Error) => { outcome = { rejected: err.message } },
    )
    await act(async () => { await Promise.resolve() })
    expect(opened).toHaveLength(1)
    expect(outcome).toBeNull()

    await act(async () => { root.unmount() })
    // Raced against a timer rather than simply awaited: the bug this covers is
    // a promise that NEVER settles, and a test that waits for one is a test
    // that hangs until vitest's own timeout rather than saying what went wrong.
    await act(async () => {
      await Promise.race([pending, new Promise((r) => setTimeout(r, 100))])
    })

    // Rejected with the same sentence any other close produces, so the checkout
    // ends up in the state it would have been in anyway: basket intact, button
    // live, one readable line.
    expect(outcome).toEqual({ rejected: ATOA_MESSAGES.closed })
    expect(disposed).toBeGreaterThan(0)
  })

  it('leaves an already-settled payment alone', async () => {
    await mount()
    let outcome: unknown = null
    const pending = submit!(config).then(
      (value) => { outcome = { resolved: value } },
      (err: Error) => { outcome = { rejected: err.message } },
    )
    await act(async () => { await Promise.resolve() })

    // Atoa says the money is in, before the component goes anywhere.
    await act(async () => {
      opened[0]?.onPaymentStatusChange?.({ status: 'COMPLETED', paymentRequestId: 'pr_test_1' })
      await pending
    })
    expect(outcome).toEqual({ resolved: { paymentRequestId: 'pr_test_1' } })

    // Unmounting afterwards must not turn a paid order into an error.
    await act(async () => { root.unmount() })
    expect(outcome).toEqual({ resolved: { paymentRequestId: 'pr_test_1' } })
  })

  it('withdraws the submit handle when it leaves the page', async () => {
    const handles: Array<((config: Record<string, unknown>) => Promise<unknown>) | null> = []
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        <AtoaCheckoutFields
          config={config}
          payer={payer}
          onError={() => {}}
          registerSubmit={(fn) => { handles.push(fn) }}
        />,
      )
    })
    await act(async () => { root.unmount() })
    expect(handles.at(-1)).toBeNull()
  })
})
