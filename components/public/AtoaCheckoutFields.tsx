'use client'

// Atoa's payment dialog, opened over the shop's own checkout. Registered on
// shop's 'shop.checkout-payment-fields' extension point under the ATOA method
// id, and mounted under the method's radio button once the shopper picks it.
//
// Only ever rendered when the owner has set payment entry to "on-page": the
// hosted-redirect mode returns no clientFields and no publishable config at all
// (see getClientFields in lib/provider.ts), so shop has nothing to mount this
// with and Atoa's SDK never reaches that shop's checkout.
//
// There are no fields to fill in here, which makes this component unusual for
// this extension point: everything the shopper types happens inside Atoa's own
// dialog, and after that inside their bank. What this draws is a line of
// reassurance; what it does is open the dialog when "Place order" is pressed and
// wait for Atoa to say what happened.
//
// **Nothing here decides anything.** Whatever the dialog reports, the payload
// handed back goes to shop's confirm route, which asks the provider - which asks
// Atoa's own API and re-checks the amount and the currency against the order.
// The browser's word is a hint about when to look, never evidence.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ShopCheckoutPaymentFieldsProps } from '@/modules/shop/components/public/checkout-payment-fields'
import {
  loadAtoaSdk, stringField, toAtoaSdkEnvironment,
  type AtoaPaymentStatusEvent, type AtoaWebSdkInstance,
} from '@/modules/pay-with-atoa-for-shop/components/public/atoa-sdk'
import { ATOA_MESSAGES, atoaClientOutcome, atoaCloseMessage } from '@/modules/pay-with-atoa-for-shop/components/public/atoa-messages'
import { isDarkBackdrop } from '@/modules/pay-with-atoa-for-shop/components/public/backdrop'

const hintStyle = { color: 'var(--color-text-muted)', fontSize: '0.8125rem', margin: 0 } as const

export function AtoaCheckoutFields({ config, payer, onError, registerSubmit }: ShopCheckoutPaymentFieldsProps) {
  // The component's outermost element - where the backdrop measurement starts,
  // since everything inside it is this component's own paint.
  const outerRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<AtoaWebSdkInstance | null>(null)
  // How to finish off a payment this component is still waiting on. Held here
  // rather than left inside the promise because the promise has to be settled
  // from somewhere else entirely: see the unmount effect at the bottom.
  const abandonRef = useRef<((message: string) => void) | null>(null)
  const [darkPage, setDarkPage] = useState(false)

  // Held in refs so the effects below stay keyed on the things that actually
  // matter. All three props are new values on every render of the checkout - a
  // keystroke in the contact box would otherwise re-register the submit handle
  // on every letter typed.
  const payerRef = useRef(payer)
  const registerRef = useRef(registerSubmit)
  const onErrorRef = useRef(onError)

  // Declared before every other effect on purpose: effects run in the order
  // they are written, so this is what guarantees the ones below read this
  // render's props rather than the previous render's.
  useEffect(() => {
    payerRef.current = payer
    registerRef.current = registerSubmit
    onErrorRef.current = onError
  })

  const environment = stringField(config, 'environment')
  const paymentRequestId = stringField(config, 'paymentRequestId')

  // Fetched when the method is picked rather than when "Place order" is
  // pressed. It is 330 KB of third-party script: waiting until the press means
  // the shopper watches a spinner while it downloads, on the one screen where
  // hesitation costs an order.
  useEffect(() => {
    let cancelled = false
    loadAtoaSdk().catch(() => {
      if (!cancelled) onErrorRef.current(ATOA_MESSAGES.loadFailed)
    })
    return () => { cancelled = true }
  }, [])

  // Whether the checkout around this is dark, measured rather than read off
  // data-theme (see backdrop.ts - a site with a dark brand palette paints a
  // dark checkout while the attribute still says light). Used for one sentence
  // of warning, because Atoa's dialog is light whatever the page is.
  //
  // In a frame rather than in the effect body: the surrounding panel has to
  // have been painted before there is a colour to measure, and a synchronous
  // setState in an effect is the render-loop hazard the lint rule is about.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setDarkPage(isDarkBackdrop(outerRef.current?.parentElement ?? null))
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  // Opens the dialog and resolves once Atoa says the payment is done. Every
  // message it throws is written for the shopper, because throwing from here is
  // what shop shows on the checkout's error line.
  const submit = useCallback(async (callConfig: Record<string, unknown>): Promise<unknown> => {
    // Taken from what shop hands over AT CALL TIME, not from the props this
    // component last rendered with. "Place order" creates the payment intent
    // and calls this in the same breath, without waiting for React to
    // re-render, so the closure below is routinely the one from before the
    // intent existed - and its paymentRequestId is an empty string. The props
    // are only the fallback, for the case where the two are already the same.
    const requestId = stringField(callConfig, 'paymentRequestId') || paymentRequestId
    const sdkEnvironment = toAtoaSdkEnvironment(stringField(callConfig, 'environment') || environment)
    // No guessed environment, ever: the wrong one asks Atoa about a payment
    // request that does not exist there, and tells the shopper their perfectly
    // good payment is invalid.
    if (!requestId || !sdkEnvironment) throw new Error(ATOA_MESSAGES.notReady)

    let AtoaWebSdk
    try {
      AtoaWebSdk = await loadAtoaSdk()
    } catch {
      throw new Error(ATOA_MESSAGES.loadFailed)
    }

    const email = payerRef.current.email.trim()

    return new Promise<{ paymentRequestId: string }>((resolve, reject) => {
      let settled = false
      // Whether the dialog has reported a problem of its own. Only ever
      // colours the sentence the shopper is eventually given - it settles
      // nothing by itself, because Atoa's dialog does not give up when it
      // reports one. See onError.
      let reported = false
      // Watches for the dialog leaving the page without saying so. See the
      // note where it is set up.
      let removalWatch: MutationObserver | null = null

      // The dialog is Atoa's element in this page's own body, so taking it away
      // is our job once it has said its piece. Deferred by a microtask because
      // this runs from inside the dialog's own callback, and removing an
      // element in the middle of dispatching its event is asking for trouble.
      const teardown = () => {
        removalWatch?.disconnect()
        removalWatch = null
        const sdk = dialogRef.current
        dialogRef.current = null
        queueMicrotask(() => sdk?.dispose())
      }
      const succeed = () => {
        if (settled) return
        settled = true
        abandonRef.current = null
        teardown()
        // The id, and nothing that looks like a verdict. The confirm route
        // ignores this payload entirely and asks Atoa itself; it is here so the
        // server-side record and the browser's story can be compared if they
        // ever disagree.
        resolve({ paymentRequestId: requestId })
      }
      const fail = (message: string) => {
        if (settled) return
        settled = true
        abandonRef.current = null
        teardown()
        reject(new Error(message))
      }
      // Published so the unmount cleanup can end this one payment. Nothing else
      // may touch it.
      abandonRef.current = fail

      const onStatus = (event: AtoaPaymentStatusEvent) => {
        const outcome = atoaClientOutcome(event?.status)
        if (outcome === 'settled') succeed()
        else if (outcome === 'failed') fail(ATOA_MESSAGES.failed)
        // 'waiting' does nothing on purpose - the shopper is still in the
        // middle of it, and PENDING here does not mean the money has moved.
      }

      try {
        const sdk = new AtoaWebSdk({
          environment: sdkEnvironment,
          paymentRequestId: requestId,
          // Email only. Atoa also takes a phone number and a country code, and
          // the checkout has at most one undivided phone string - splitting a
          // number into a country code and the rest by guesswork puts the wrong
          // number in front of somebody's bank, and Atoa's own default country
          // code is not ours to assume either.
          ...(email ? { customerDetails: { email } } : {}),
          onPaymentStatusChange: onStatus,
          // A close carrying a terminal status says what happened; one carrying
          // nothing is the shopper shutting the window, which is not an error
          // and leaves the checkout and the basket exactly as they were.
          onClose: (event) => {
            if (atoaClientOutcome(event?.status) === 'settled') succeed()
            else fail(atoaCloseMessage(event?.status, reported))
          },
          onUserCancel: () => fail(reported ? ATOA_MESSAGES.errored : ATOA_MESSAGES.cancelled),
          // **Reported, not fatal, and this window stays open.** Atoa's dialog
          // hands every problem it meets to this callback and then carries on
          // drawing itself: a failed load of the payment's own details leaves
          // its "Error processing payment" pane on screen, with its own close
          // button, and the dialog element still in the page. Taking it away
          // here - which is what this used to do - is how a shopper pressed
          // "Place order", saw Atoa's window appear and vanish in the same
          // breath, and was left with no window, no explanation and no idea
          // what to try next.
          //
          // The commonest cause is a web address Atoa has not been told about:
          // their API answers such an origin with a 403 and no CORS headers, so
          // every call the dialog makes fails at the browser and this fires.
          // The dashboard's domain whitelist is the fix, and the settings tab
          // says so - but a shop that has missed it must still show the
          // shopper the error rather than a flicker.
          //
          // Atoa's own wording is written for a console ("[Atoa Web SDK] Error
          // displaying payment dialog"), so it goes to one.
          onError: (err) => {
            reported = true
            console.warn('[pay-with-atoa] payment dialog error', err)
          },
        })
        dialogRef.current = sdk
        sdk.showPaymentDialog()

        // Atoa's dialog is a custom element with its own shadow root, appended
        // to <body> - not an iframe - and everything it draws is a fixed light
        // palette (it writes that palette onto the document element itself when
        // it opens). `color-scheme` inherits through a shadow boundary, so on a
        // checkout that declares itself dark the browser would paint ITS idea of
        // a dark control inside a white dialog - dark-on-white text in Atoa's
        // own bank search box. Declaring this subtree light makes the browser's
        // painting agree with what Atoa actually drew. It touches nothing inside
        // the dialog: an inherited property on the host element is the whole of
        // it, and the light value is the one their palette is built for.
        // The last one, not the first: a dialog from an earlier attempt is
        // disposed of on its way out, but querying for the newest is the
        // answer that stays right whatever order that happens in.
        const hosts = document.querySelectorAll('atoa-pay-sdk-dialog')
        const host = hosts[hosts.length - 1]
        if (host instanceof HTMLElement) {
          host.style.colorScheme = 'light'

          // The dialog gone from the page with nothing said about it. Every
          // route Atoa documents ends in one of the callbacks above, so this
          // should never fire - but the promise handed to shop is what keeps
          // "Place order" disabled, and the cost of being wrong about "should
          // never" is a button that is dead for the rest of the page's life
          // with nothing on screen to say why. It became worth guarding the
          // moment onError stopped settling: that was, by accident, the only
          // thing catching a dialog that ended without a word.
          removalWatch = new MutationObserver(() => {
            if (settled || host.isConnected) return
            fail(reported ? ATOA_MESSAGES.errored : ATOA_MESSAGES.closed)
          })
          removalWatch.observe(document.body, { childList: true })
        }
      } catch (err) {
        console.warn('[pay-with-atoa] payment dialog could not be opened', err)
        fail(ATOA_MESSAGES.errored)
      }
    })
  }, [paymentRequestId, environment])

  // Registered separately from the loading above, so the handle is withdrawn
  // the moment this component leaves the page - a shopper who switches to bank
  // transfer must not have "Place order" reach for a dialog that is gone.
  useEffect(() => {
    registerRef.current(submit)
    return () => registerRef.current(null)
  }, [submit])

  // A dialog still open when the checkout moves on would sit over whatever
  // comes next, with nothing left to answer it.
  //
  // **Settle the promise BEFORE disposing of the dialog.** `dispose()` is
  // `removeDialog(); dialogElement = null; providedSdkOptions = null` and calls
  // none of the callbacks - only the shopper's own close and cancel do that. So
  // taking the dialog away on its own leaves the promise this component handed
  // to shop pending for ever, and shop keeps its "placing the order" flag
  // raised: "Place order" stays disabled for the rest of the page's life, with
  // nothing on screen to say why. Rejecting first leaves the checkout in
  // exactly the state any other close leaves it in - basket intact, button
  // live, one readable sentence - which is the truth of it either way.
  //
  // Hard to reach on purpose (the dialog's own full-screen scrim sits over the
  // radio buttons that would unmount this), but shop's checkout-payment slot
  // can re-target its portal and remount the component underneath, and a dead
  // button with no explanation is a bad way to fail.
  useEffect(() => {
    return () => {
      abandonRef.current?.(ATOA_MESSAGES.closed)
      abandonRef.current = null
      const sdk = dialogRef.current
      dialogRef.current = null
      sdk?.dispose()
    }
  }, [])

  return (
    <div ref={outerRef} style={{ display: 'grid', gap: '0.5rem' }}>
      {/* Said here rather than by the checkout, because only this component
          knows what is being asked for. Every colour is a semantic variable, so
          it follows the site into either theme. */}
      <p style={hintStyle}>
        🔒 Place your order and a window from Atoa opens here. You approve the payment in your own
        banking app - your bank details never touch this site.
      </p>
      {darkPage && (
        // Measured, not assumed (see the effect above). Atoa's dialog has one
        // set of colours and they are light ones, so on a dark checkout it
        // arrives as a bright window. Better said a line early than met as a
        // surprise at the moment of paying - the same courtesy shop extends
        // before handing a shopper to a payment provider's own site.
        <p style={hintStyle}>Atoa&apos;s payment window opens in its own light colours.</p>
      )}
    </div>
  )
}
