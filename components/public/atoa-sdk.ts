// Atoa's web client SDK: the loader, and the slice of its shape this module
// actually calls. Its own file so that however many of this module's components
// end up on one checkout, exactly one copy of the script is ever fetched and
// booted.
//
// **The UMD build, not the package's main entry.** `main` is
// dist/atoa-web-client-sdk.min.js, which is an ES module - it ends in an
// `export` statement, so a plain <script src> tag dies on "Unexpected token
// 'export'" and defines no global at all. The bare
// https://unpkg.com/@atoapayments/atoa-web-client-sdk@1.0.1 URL resolves to
// exactly that file. dist/atoa-web-client-sdk.umd.min.cjs is the same release
// wrapped for a script tag, and it is what puts window.AtoaPayWebSdk there.
//
// Pinned to one exact version, deliberately. This is third-party code on a page
// where somebody is paying: an unpinned CDN tag is an open invitation for that
// code to change under us between one order and the next. A version bump here
// is a change to review, which is the point.
//
// Module package.json dependencies are not installed by
// scripts/checkout-modules.mjs, so bundling the npm package is not on offer -
// the script tag is the only route, and it is the one square-payment-for-shop
// already takes.
//
// Only what is called is typed. The package does ship its own types, but they
// are not reachable from a global loaded at runtime, so the interfaces below are
// a narrow hand-written mirror of the handful of members this module touches.

// Atoa's own spelling, and it validates the value: an unrecognised environment
// throws inside the SDK constructor, and an absent one leaves it building a
// request against `undefined`. So this module never guesses one - see
// toAtoaSdkEnvironment.
export type AtoaSdkEnvironment = 'SANDBOX' | 'PRODUCTION'

// What the dialog reports back. Deliberately `unknown`-ish: these come from a
// third party's callback and nothing here may assume a shape it has not
// checked. The status is narrowed in atoa-messages.ts.
export type AtoaPaymentStatusEvent = {
  status?: unknown
  paymentRequestId?: unknown
}

export type AtoaSdkErrorEvent = {
  name?: unknown
  message?: unknown
  details?: unknown
  componentName?: unknown
}

export type AtoaSdkOptions = {
  environment: AtoaSdkEnvironment
  paymentRequestId: string
  customerDetails?: { email?: string; phoneCountryCode?: string; phoneNumber?: string }
  onPaymentStatusChange?: (event: AtoaPaymentStatusEvent) => void
  // Fired when the dialog closes, carrying whatever status it last had. A close
  // with nothing terminal in it is a shopper changing their mind, not a failure.
  onClose?: (event: AtoaPaymentStatusEvent) => void
  onUserCancel?: (paymentRequestId: string) => void
  onError?: (error: AtoaSdkErrorEvent) => void
}

export type AtoaWebSdkInstance = {
  showPaymentDialog: () => void
  // Removes the dialog element and drops its listeners. Not in Atoa's own
  // documented surface, but it is on the class - and a component that opens a
  // payment dialog without a way to take it away again leaves one over the
  // checkout of a shopper who has moved on.
  dispose: () => void
}

export type AtoaWebSdkConstructor = new (options: AtoaSdkOptions) => AtoaWebSdkInstance

declare global {
  interface Window {
    AtoaPayWebSdk?: { AtoaWebSdk?: AtoaWebSdkConstructor }
  }
}

export const ATOA_SDK_VERSION = '1.0.1'
export const ATOA_SDK_URL =
  `https://unpkg.com/@atoapayments/atoa-web-client-sdk@${ATOA_SDK_VERSION}/dist/atoa-web-client-sdk.umd.min.cjs`

/** The environment as the SDK spells it, or null when the value is not one of
 *  the two. Never a fallback: a dialog booted in the wrong environment asks
 *  Atoa about a payment request that does not exist there, and the shopper is
 *  told their perfectly good payment link is invalid. Refusing is the honest
 *  answer, and the caller turns it into a sentence. */
export function toAtoaSdkEnvironment(value: unknown): AtoaSdkEnvironment | null {
  return value === 'SANDBOX' || value === 'PRODUCTION' ? value : null
}

// One load per page, however many times the shopper switches method and back.
let sdkPromise: Promise<AtoaWebSdkConstructor> | null = null

function readConstructor(): AtoaWebSdkConstructor | null {
  const ctor = window.AtoaPayWebSdk?.AtoaWebSdk
  return typeof ctor === 'function' ? ctor : null
}

export function loadAtoaSdk(): Promise<AtoaWebSdkConstructor> {
  const already = readConstructor()
  if (already) return Promise.resolve(already)
  if (sdkPromise) return sdkPromise

  sdkPromise = new Promise<AtoaWebSdkConstructor>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = ATOA_SDK_URL
    script.async = true
    script.onload = () => {
      const ctor = readConstructor()
      // Loaded, but not what we asked for. A CDN that answered with something
      // else - an error page, a rewritten build - must not leave the checkout
      // waiting on a global that is never coming.
      if (!ctor) {
        sdkPromise = null
        reject(new Error('The bank payment window could not be loaded.'))
        return
      }
      resolve(ctor)
    }
    script.onerror = () => {
      // Cleared so a shopper who tries again once their connection is back gets
      // a fresh attempt rather than the cached rejection.
      sdkPromise = null
      reject(new Error('The bank payment window could not be loaded.'))
    }
    document.head.appendChild(script)
  })
  return sdkPromise
}

/** A string out of the config shop hands over, or ''. The config is a
 *  Record<string, unknown> by contract, so every read of it is a narrowing. */
export function stringField(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}
