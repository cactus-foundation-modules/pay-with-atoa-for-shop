'use client'

// "Pay With Atoa" panel. The manifest settingsTabs entry sets host
// "shop.payments", so this renders inside admin > Shop > Payments alongside
// Stripe and PayPal rather than as a top-level Settings tab. Credentials are
// stored as environment variables through the core-managed /api/admin/env route
// (declared via requiredEnvVars); everything else here is this module's own
// stored settings.
//
// The environment picker deliberately does NOT go through /api/admin/env. An
// environment variable written there only reaches the running server at the
// next deployment, so the panel would re-read the old value the moment it
// reloaded and put the dropdown straight back where it started - a save that
// looked like a failure. Being a stored setting, it applies immediately.
//
// Sandbox and production have their own separate boxes, because they have their
// own separate credentials. Both sets are shown at once so "(set)" always means
// "set for that environment".
//
// Every colour here is a semantic variable or an admin class. Sandbox and
// production share one Atoa host, so which one is live is the single most
// consequential thing on this screen and it is said in words, in a banner, and
// beside the dropdown - not left to be inferred from a select nobody read.
import { useEffect, useState } from 'react'

type Environment = 'sandbox' | 'production'
type PaymentEntry = 'redirect' | 'on-page'

const MAX_DESCRIPTION = 30
const MIN_EXPIRY_MINUTES = 5
const MAX_EXPIRY_MINUTES = 1440

const ENVIRONMENTS: Array<{ id: Environment; label: string; hint: string }> = [
  { id: 'sandbox', label: 'Sandbox', hint: 'Test payments only. No real money moves, and real customers cannot pay.' },
  { id: 'production', label: 'Production', hint: 'Real bank payments from real customers, into your real account.' },
]

type FieldDef = { field: 'accessSecret' | 'webhookSigningSecret'; label: string; placeholder: string; help: string }

const FIELDS: FieldDef[] = [
  {
    field: 'accessSecret',
    label: 'Access secret',
    placeholder: '••••••••',
    help: 'In the Atoa dashboard: the gear icon in the left sidebar, then Settings inside it, then API Access. Settings twice over is their menu, not a mistake here. That page has a separate Sandbox and Production section. The secret itself is the key - the access ID next to it is not used and is not needed here.',
  },
  {
    field: 'webhookSigningSecret',
    label: 'Webhook signing secret',
    placeholder: 'whsec_…',
    help: 'A different page from the one above: same gear icon and same Settings, but Webhooks rather than API Access, then Generate a signing key. Atoa shows it once and never again, so paste it straight in. Until you have it, this payment method stays off your checkout: without it there is no way to tell a real payment confirmation from a made-up one.',
  },
]

// Must match atoaEnvVarNames() in lib/env.ts.
const ENV_VAR_SUFFIX: Record<FieldDef['field'], string> = {
  accessSecret: 'ACCESS_SECRET',
  webhookSigningSecret: 'WEBHOOK_SIGNING_SECRET',
}

function envVarName(environment: Environment, field: FieldDef['field']): string {
  const prefix = environment === 'sandbox' ? 'ATOA_SANDBOX_' : 'ATOA_'
  return `${prefix}${ENV_VAR_SUFFIX[field]}`
}

type Status = {
  environment: string
  accessSecretSet?: boolean
  webhookSigningSecretSet?: boolean
  webhookUrl?: string
  storedWebhookEndpointId?: string | null
  configured: boolean
  connected?: boolean
  error?: string
  webhookRegistered?: boolean
  webhookEndpointId?: string | null
  webhookEvents?: string[]
  webhookError?: string
}

type Settings = {
  enabled: boolean
  paymentDescription: string
  environment: Environment
  paymentEntry: PaymentEntry
  expiresInMinutes: number
  allowCard: boolean
  webhookEndpointId: string | null
}

// Joins a list into the sentence an actual person would say.
function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

const subtleText = { color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' } as const

export function AtoaSettingsTab() {
  const [setVars, setSetVars] = useState<Record<string, boolean>>({})
  const [values, setValues] = useState<Record<string, string>>({})
  const [environment, setEnvironment] = useState<Environment>('sandbox')
  const [localMode, setLocalMode] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)

  const [savingConn, setSavingConn] = useState(false)
  const [savedConn, setSavedConn] = useState(false)
  const [connError, setConnError] = useState('')

  const [savingSettings, setSavingSettings] = useState(false)
  const [savedSettings, setSavedSettings] = useState(false)
  const [settingsError, setSettingsError] = useState('')

  const [registering, setRegistering] = useState(false)
  const [registerNote, setRegisterNote] = useState('')
  const [registerError, setRegisterError] = useState('')

  async function load() {
    try {
      const [envRes, statusRes, settingsRes] = await Promise.all([
        fetch('/api/admin/env'),
        fetch('/api/m/pay-with-atoa-for-shop/admin/status'),
        fetch('/api/m/pay-with-atoa-for-shop/admin/settings'),
      ])
      if (envRes.ok) {
        const d = await envRes.json()
        setSetVars(d.vars ?? {})
        setLocalMode(!!d.localMode)
      }
      if (statusRes.ok) setStatus((await statusRes.json()) as Status)
      if (settingsRes.ok) {
        const s = (await settingsRes.json()) as Settings
        setSettings(s)
        if (s.environment === 'production' || s.environment === 'sandbox') setEnvironment(s.environment)
      }
    } catch {
      // Sections still render with defaults.
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async loader; every setState in load() runs after an await, never synchronously in the effect body
    load()
  }, [])

  async function saveConnection() {
    setSavingConn(true)
    setSavedConn(false)
    setConnError('')
    try {
      // Only non-blank fields are sent, so a blank box leaves the stored value
      // alone rather than wiping it.
      const vars = Object.entries(values)
        .map(([key, value]) => ({ key, value: value.trim() }))
        .filter((v) => v.value !== '')
      // The environment saves itself the moment it is picked, so an untouched
      // form really has nothing to send. Saying "Saved" over an empty request is
      // how a credential ends up looking stored when nothing happened.
      if (vars.length === 0) {
        throw new Error('Nothing to save - fill in an access secret or a webhook signing secret first.')
      }

      const res = await fetch('/api/admin/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vars }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Failed to save')
      // Core only stores keys the installed modules declare. If it dropped any,
      // say so rather than show a green "Saved" over a credential that is not
      // there - it means this site's Atoa module needs updating.
      if (Array.isArray(d.skipped) && d.skipped.length > 0) {
        throw new Error(`Not stored: ${d.skipped.join(', ')}. Update the Pay With Atoa module to its latest version, then save again.`)
      }
      setSavedConn(true)
      setValues({})
      await load()
    } catch (err) {
      setConnError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSavingConn(false)
    }
  }

  async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
    const res = await fetch('/api/m/pay-with-atoa-for-shop/admin/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const d = await res.json()
    if (!res.ok) throw new Error(d.error ?? 'Failed to save')
    const saved = d as Settings
    setSettings(saved)
    return saved
  }

  async function saveSettings(next: Partial<Settings>) {
    setSavingSettings(true)
    setSavedSettings(false)
    setSettingsError('')
    try {
      await patchSettings(next)
      setSavedSettings(true)
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSavingSettings(false)
    }
  }

  // Which environment is live is a stored setting, not an environment variable,
  // so it applies at once - no deployment, and nothing to press Save for. The
  // status panel is re-read straight afterwards because "is this connected" has
  // an entirely different answer for the other environment's credentials.
  async function chooseEnvironment(next: Environment) {
    const previous = environment
    setEnvironment(next)
    setSavingConn(true)
    setSavedConn(false)
    setConnError('')
    try {
      await patchSettings({ environment: next })
      await load()
    } catch (err) {
      setEnvironment(previous)
      setConnError(err instanceof Error ? err.message : 'Could not switch environment')
    } finally {
      setSavingConn(false)
    }
  }

  async function registerWebhook() {
    setRegistering(true)
    setRegisterNote('')
    setRegisterError('')
    try {
      const res = await fetch('/api/m/pay-with-atoa-for-shop/admin/register-webhook', { method: 'POST' })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Atoa refused the registration')
      setRegisterNote(
        d.alreadyRegistered
          ? 'This address was already registered with Atoa, so nothing new was created.'
          : 'Registered. Atoa will now tell your shop the moment a payment lands.',
      )
      await load()
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : 'Atoa refused the registration')
    } finally {
      setRegistering(false)
    }
  }

  // Which credentials the RUNNING server still cannot see. "Saved" and "working"
  // are two different things: a credential written through /api/admin/env goes
  // to the hosting project, and the running server carries on with the old
  // environment until the site next deploys. So a box can show "(set)" - that
  // list comes from the hosting project - while the status panel, which reads
  // what the server can actually see, still says no. Telling somebody to add a
  // secret they added a minute ago is wrong; what they want is a deployment.
  function missingCredentials(): { pending: string[]; absent: string[] } {
    const env: Environment = status?.environment === 'production' ? 'production' : 'sandbox'
    const wanted: Array<{ field: FieldDef['field']; label: string; seen: boolean }> = [
      { field: 'accessSecret', label: 'access secret', seen: status?.accessSecretSet !== false },
      { field: 'webhookSigningSecret', label: 'webhook signing secret', seen: status?.webhookSigningSecretSet !== false },
    ]
    const pending: string[] = []
    const absent: string[] = []
    for (const c of wanted) {
      if (c.seen) continue
      ;(setVars[envVarName(env, c.field)] ? pending : absent).push(c.label)
    }
    return { pending, absent }
  }

  function renderCredentials(env: Environment) {
    const meta = ENVIRONMENTS.find((e) => e.id === env)
    if (!meta) return null
    const isLive = environment === env

    return (
      <div
        key={env}
        style={{
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--space-4)',
          marginBottom: 'var(--space-4)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-1)' }}>
          <strong style={{ color: 'var(--color-text)' }}>{meta.label}</strong>
          {isLive && (
            <span
              style={{
                fontSize: 'var(--text-xs)',
                // The same token the Square panel's "In use" chip uses. The
                // danger colour was tried here and dropped: on the dark theme
                // it lands at 4.48:1 against the card, which is under AA for
                // text this size, and the environment is already shouted about
                // in the banner above.
                color: 'var(--color-success, var(--color-text-secondary))',
                border: '1px solid currentColor',
                borderRadius: 'var(--radius-sm)',
                padding: '0 var(--space-2)',
              }}
            >
              In use
            </span>
          )}
        </div>
        <p style={{ ...subtleText, margin: '0 0 var(--space-3)' }}>{meta.hint}</p>

        {FIELDS.map(({ field, label, placeholder, help }) => {
          const key = envVarName(env, field)
          return (
            <div className="field" key={key}>
              <label htmlFor={`atp-${key}`}>
                {label}
                {setVars[key] && (
                  <span style={{ marginLeft: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-success, var(--color-text-secondary))' }}>
                    (set)
                  </span>
                )}
              </label>
              <p style={{ ...subtleText, margin: '0 0 var(--space-2)' }}>{help}</p>
              <input
                id={`atp-${key}`}
                type="password"
                value={values[key] ?? ''}
                placeholder={setVars[key] ? 'Leave blank to keep current value' : placeholder}
                onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                autoComplete="off"
              />
            </div>
          )
        })}
      </div>
    )
  }

  const descriptionLeft = MAX_DESCRIPTION - (settings?.paymentDescription.length ?? 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div className="card">
        <h2 className="card-title">Pay With Atoa</h2>
        <p style={{ ...subtleText, margin: '0 0 var(--space-4)' }}>
          Let shoppers pay straight from their bank account, no card needed. Sandbox and production
          have their own secrets, so each gets its own box below - fill in whichever you are using,
          pick which one the shop should use, then turn the method on. Both come from the{' '}
          <a href="https://business.paywithatoa.co.uk/" target="_blank" rel="noreferrer">
            Atoa business dashboard
          </a>
          . Payments are in pounds only, and Atoa will not take an order under £1.
        </p>

        {/* The one thing on this screen worth shouting about. Sandbox and
            production are the same web address with different secrets, so
            nothing about the page itself tells you which one you are in. */}
        {environment === 'production' ? (
          <div className="alert alert-danger">
            <strong>Production - this is real money.</strong> Every payment taken here comes out of a
            real customer&apos;s real bank account and lands in yours.
          </div>
        ) : (
          <div className="alert alert-warning">
            <strong>Sandbox - test payments only.</strong> Nothing here moves real money, and a real
            customer cannot pay you. Switch to Production when you are ready to trade.
          </div>
        )}

        {connError && <div className="alert alert-danger">{connError}</div>}
        {savedConn && <div className="alert alert-success">Saved. Changes take effect after the next deployment.</div>}

        {status && (
          !status.configured ? (
            (() => {
              const { pending, absent } = missingCredentials()
              return (
                <>
                  {pending.length > 0 && (
                    <div className="alert alert-warning">
                      Saved, but not live yet. The {listWords(pending)} for{' '}
                      <strong>{status.environment}</strong> {pending.length === 1 ? 'is' : 'are'} stored
                      with your hosting and will start working after the site&apos;s next deployment -
                      secrets only reach the running site when it redeploys. Deploy from the
                      notification on your dashboard, then come back to this page.
                    </div>
                  )}
                  {absent.length > 0 && (
                    <div className="alert alert-warning">
                      Not connected yet - add the {listWords(absent)} for{' '}
                      <strong>{status.environment}</strong> below.
                    </div>
                  )}
                  {pending.length === 0 && absent.length === 0 && (
                    <div className="alert alert-warning">
                      Not connected yet - check the secrets for <strong>{status.environment}</strong> below.
                    </div>
                  )}
                </>
              )
            })()
          ) : status.connected ? (
            <div className="alert alert-success">
              Connected to Atoa (<strong>{status.environment}</strong>).
            </div>
          ) : (
            <div className="alert alert-danger">
              The secrets are set but Atoa rejected them{status.error ? `: ${status.error}` : ''}.
            </div>
          )
        )}

        {/* Outside the local-development branch on purpose: the choice is kept
            here rather than in the hosting project, so it works the same way
            everywhere and needs no deployment to take hold. */}
        <div className="field">
          <label htmlFor="atp-environment">Which environment the shop uses</label>
          <p style={{ ...subtleText, margin: '0 0 var(--space-2)' }}>
            Saved as soon as you pick it and live straight away - no deployment needed. Atoa uses the
            same web address for both, and it is the secret that decides which one you are in, so make
            sure the boxes below are filled in for whichever you choose.
          </p>
          <select
            id="atp-environment"
            value={environment}
            disabled={savingConn}
            onChange={(e) => chooseEnvironment(e.target.value === 'production' ? 'production' : 'sandbox')}
          >
            <option value="sandbox">Sandbox (testing - no real money)</option>
            <option value="production">Production (real money)</option>
          </select>
        </div>

        {localMode ? (
          <div className="alert alert-warning">
            Local development mode: set <code>ATOA_ACCESS_SECRET</code> and{' '}
            <code>ATOA_WEBHOOK_SIGNING_SECRET</code> (or their <code>ATOA_SANDBOX_</code> twins) in{' '}
            <code>.env.local</code> and restart the dev server.
          </div>
        ) : (
          <>
            {ENVIRONMENTS.map((e) => renderCredentials(e.id))}

            <button className="btn btn-primary" disabled={savingConn} onClick={saveConnection}>
              {savingConn ? 'Saving…' : 'Save connection'}
            </button>
          </>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">Payment confirmations</h2>
        <p style={{ ...subtleText, margin: '0 0 var(--space-4)' }}>
          Atoa tells your shop when a payment lands, so an order confirms itself even if the shopper
          closes the tab on the way back. Unlike most payment services, you do not have to paste a
          web address anywhere - press the button and this site registers itself.
        </p>

        {registerError && <div className="alert alert-danger">{registerError}</div>}
        {registerNote && <div className="alert alert-success">{registerNote}</div>}

        {status?.webhookRegistered === true && (
          <div className="alert alert-success">
            Registered with Atoa for <strong>{status.environment}</strong>.
          </div>
        )}
        {status?.configured && status.connected && status.webhookRegistered === false && (
          <div className="alert alert-warning">
            Not registered for <strong>{status.environment}</strong> yet. Payments still go through and
            are confirmed when the shopper comes back - but anyone who pays and then closes the tab
            will need confirming by hand. Each environment needs its own registration.
          </div>
        )}
        {status?.webhookError && (
          <div className="alert alert-warning">
            Could not check with Atoa whether this is registered: {status.webhookError}
          </div>
        )}

        <div className="field">
          <label htmlFor="atp-webhook-url">Where Atoa sends confirmations</label>
          <p style={{ ...subtleText, margin: '0 0 var(--space-2)' }}>
            Shown for your records. Atoa cannot change an address once it is registered - it has to be
            removed and added again - so this needs to be your live site, not a test one.
          </p>
          <input id="atp-webhook-url" type="text" value={status?.webhookUrl ?? ''} readOnly onFocus={(e) => e.target.select()} />
        </div>

        <button
          className="btn btn-primary"
          disabled={registering || !status?.configured || status?.connected === false}
          onClick={registerWebhook}
        >
          {registering ? 'Registering…' : 'Register webhook'}
        </button>
      </div>

      <div className="card">
        <h2 className="card-title">Payment method</h2>
        <p style={{ ...subtleText, margin: '0 0 var(--space-4)' }}>
          When switched on, pay by bank appears as a payment option at checkout (as long as the
          connection above is working).
        </p>

        {settingsError && <div className="alert alert-danger">{settingsError}</div>}
        {savedSettings && <div className="alert alert-success">Saved.</div>}

        {settings && (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', margin: '0 0 var(--space-4)', color: 'var(--color-text)' }}>
              <input
                type="checkbox"
                checked={settings.enabled}
                disabled={savingSettings}
                onChange={(e) => saveSettings({ enabled: e.target.checked })}
              />
              Offer pay by bank at checkout
            </label>

            <div className="field">
              <label htmlFor="atp-description">Payment description</label>
              <p style={{ ...subtleText, margin: '0 0 var(--space-2)' }}>
                What the shopper sees against the payment in their banking app. Leave it blank and
                they see the order number instead. Atoa allows 30 characters and refuses anything
                longer, so your shop name on its own is usually the right answer.
              </p>
              <input
                id="atp-description"
                type="text"
                maxLength={MAX_DESCRIPTION}
                value={settings.paymentDescription}
                placeholder="e.g. Your shop name"
                onChange={(e) => setSettings({ ...settings, paymentDescription: e.target.value })}
                onBlur={() => saveSettings({ paymentDescription: settings.paymentDescription })}
              />
              <p
                style={{
                  ...subtleText,
                  margin: 'var(--space-1) 0 0',
                  color: descriptionLeft === 0 ? 'var(--color-warning)' : 'var(--color-text-secondary)',
                }}
              >
                {descriptionLeft === 0
                  ? 'That is the lot - Atoa allows no more than 30 characters.'
                  : `${descriptionLeft} character${descriptionLeft === 1 ? '' : 's'} left.`}
              </p>
            </div>

            <div className="field">
              <label htmlFor="atp-expiry">How long a payment link lasts</label>
              <p style={{ ...subtleText, margin: '0 0 var(--space-2)' }}>
                In minutes. Long enough to open a banking app, find the password and approve - Atoa&apos;s
                own default is three minutes, which is not. Between {MIN_EXPIRY_MINUTES} and{' '}
                {MAX_EXPIRY_MINUTES}; 30 suits most shops.
              </p>
              <input
                id="atp-expiry"
                type="number"
                min={MIN_EXPIRY_MINUTES}
                max={MAX_EXPIRY_MINUTES}
                value={settings.expiresInMinutes}
                onChange={(e) => setSettings({ ...settings, expiresInMinutes: Number(e.target.value) })}
                onBlur={() => {
                  const clamped = Math.min(MAX_EXPIRY_MINUTES, Math.max(MIN_EXPIRY_MINUTES, Math.round(settings.expiresInMinutes) || 30))
                  setSettings({ ...settings, expiresInMinutes: clamped })
                  saveSettings({ expiresInMinutes: clamped })
                }}
              />
            </div>

            {/* Where the shopper authorises. Two labelled choices with a
                sentence each, because the difference is not one anybody can
                infer from a two-word label - and one of them needs a job doing
                in the Atoa dashboard first. */}
            <div className="field">
              <label htmlFor="atp-payment-entry">Where the shopper pays</label>
              <p style={{ ...subtleText, margin: '0 0 var(--space-2)' }}>
                Both take the payment the same way, through the shopper&apos;s own banking app. The
                difference is where they start it.
              </p>
              <select
                id="atp-payment-entry"
                value={settings.paymentEntry}
                disabled={savingSettings}
                onChange={(e) => saveSettings({ paymentEntry: e.target.value === 'on-page' ? 'on-page' : 'redirect' })}
              >
                <option value="redirect">Send them to Atoa&apos;s page</option>
                <option value="on-page">Open Atoa&apos;s window on your checkout</option>
              </select>
              <p style={{ ...subtleText, margin: 'var(--space-2) 0 0' }}>
                {settings.paymentEntry === 'on-page'
                  ? 'The shopper stays on your checkout and Atoa opens a window over it. Fewer people wander off, since they never leave your site.'
                  : 'The shopper goes off to Atoa\u2019s own page to pick their bank, then comes back to you. Nothing to set up, and it works on any site.'}
              </p>
              {settings.paymentEntry === 'on-page' && (
                <div className="alert alert-warning" style={{ marginTop: 'var(--space-3)' }}>
                  <strong>Whitelist your web address with Atoa first.</strong> On a site Atoa has not
                  been told about, their window opens and can only show an error - it is not allowed to
                  ask them anything about the payment, so the shopper gets no banks to choose from and
                  no way to pay. In the Atoa dashboard: the gear icon in the left sidebar, then Settings,
                  then API Access - &quot;Whitelist your domains&quot; is at the bottom of the same page as
                  your secrets. Add your live web address there before you switch this on.
                </div>
              )}
              <p style={{ ...subtleText, margin: 'var(--space-2) 0 0' }}>
                Whichever you pick, Atoa&apos;s window and Atoa&apos;s page are theirs and come in their
                own colours - one brand colour you set in their dashboard, and light the rest of the way
                through. They do not follow your site&apos;s light or dark theme, so choose a brand colour
                that reads well on white.
              </p>
            </div>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2)', color: 'var(--color-text)' }}>
              <input
                type="checkbox"
                checked={settings.allowCard}
                disabled={savingSettings}
                onChange={(e) => saveSettings({ allowCard: e.target.checked })}
                style={{ marginTop: '0.2rem' }}
              />
              <span>
                Let Atoa offer cards as well as bank payments
                <span style={{ display: 'block', ...subtleText }}>
                  Off by default. Bank payments are what this method is for and what makes it cheap;
                  if you already take cards through another method, adding them here only gives the
                  shopper the same choice twice. Whether Atoa can actually offer cards depends on your
                  account with them.
                  {settings.paymentEntry === 'on-page' && (
                    <span style={{ display: 'block', marginTop: 'var(--space-1)' }}>
                      Not used at the moment: with Atoa&apos;s window opening on your own checkout, the
                      card step belongs to another company again and is switched off here rather than
                      failing in front of a shopper. Bank payments only. Send shoppers to Atoa&apos;s own
                      page if you want the card option as well.
                    </span>
                  )}
                </span>
              </span>
            </label>
          </>
        )}
      </div>
    </div>
  )
}
