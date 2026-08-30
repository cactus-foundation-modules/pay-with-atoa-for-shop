<p align="center">
  <img src="module-art.webp" alt="Pay With Atoa" width="640" />
</p>

# Pay With Atoa for Shop

Adds **Pay by bank** as a checkout payment method in the Cactus Shop, powered by
[Atoa](https://paywithatoa.co.uk): a one-off, open-banking payment the shopper
approves in their own banking app. No card, no stored mandate.

- **Table prefix:** `atp_`
- **Depends on:** the `shop` module (`>= 0.1.370`. `0.1.367` exposes the
  `shop.payment-providers` extension point this hangs off; `0.1.370` is the
  first version whose refund wording tells the truth about a method that does
  not send refunds itself)

> **Phase one.** The shopper is handed to Atoa's own hosted page and sent back.
> An on-page dialog, drawn over this site's own checkout, follows in a later
> release and will be the shop owner's choice rather than a replacement.

## How it works

1. At checkout the shopper picks *Pay by bank*. The module creates an Atoa
   payment request and sends the shopper to Atoa's hosted page to approve it at
   their bank. Nothing is written to the orders list yet - the order is drafted
   and only becomes real when the money is committed, so a shopper who thinks
   better of it on somebody else's site leaves nothing behind.
2. On return, and via Atoa's webhooks, the order is confirmed: it waits at
   *Awaiting confirmation* until the payment settles, then flips to *Paid* and
   the usual order fulfilment (email, stock, downloads) runs.
3. **Refunds are not automatic yet.** See below.

## Configuration

Set the pair of variables for the environment you are using (managed on
**Settings → Pay With Atoa** in the admin, or in `.env.local` for local
development). Sandbox and production have separate variables so both sets can be
held at once:

| Variable | Purpose |
|----------|---------|
| `ATOA_ACCESS_SECRET` | Production access secret from Atoa's dashboard: the **gear icon** in the left sidebar, then **Settings** inside it, then **API Access**, Production section. (Settings twice is correct - see below.) It is the bearer token itself, there is nothing to exchange it for. |
| `ATOA_WEBHOOK_SIGNING_SECRET` | Production V2 webhook signing secret, in Atoa's `whsec_…` form. From a **different** page: same gear icon and same **Settings**, but **Webhooks** rather than API Access. |
| `ATOA_SANDBOX_ACCESS_SECRET` | The sandbox equivalent. |
| `ATOA_SANDBOX_WEBHOOK_SIGNING_SECRET` | The sandbox equivalent. |

The access **id** Atoa shows beside the secret is not needed and has no variable:
it plays no part in authentication.

**Which environment is live is a setting, not a variable** - pick it on
**Settings → Pay With Atoa**, where it takes effect on the next request rather
than on the next deployment.

### Two things to do in Atoa's dashboard

- **Generate the V2 webhook signing secret.** In the Atoa dashboard, click the
  **gear icon** in the left sidebar, then **Settings** inside the menu it opens,
  then **Webhooks**, then **Generate a signing key**. Two Settings in a row is
  the dashboard's own shape, not a typo here: the gear and the Settings item
  inside it are different things. It asks you to confirm your password,
  then shows the `whsec_…` value **once and never again**, so paste it straight
  into the settings tab. This is a different page from API Access, and the secret
  is not on that page - do not go looking for it there. Until you have it the
  method will not appear at checkout: without it there is no way to believe a
  webhook saying the money arrived, and a payment method that cannot confirm its
  own payments should not be offered.
- **Pick your brand colour.** Atoa's payment surfaces take a single brand colour
  and have no light/dark pair, so choose one that holds its contrast on a light
  page and a dark one alike.

The webhook **endpoint** is a different thing again, and there is nothing to do
about it by hand: it is registered from the settings tab over Atoa's API, so
there is no URL to paste anywhere. Registering an endpoint does **not** hand back
a signing secret - that is why the secret is an environment variable and comes
from the dashboard page above.

The API Access page also carries a per-environment **Redirect URL (Optional)**
field and a **Whitelist your domains** section. Neither is needed for this
release: the return address travels with each payment, and domain whitelisting
is for the on-page dialog that comes later.

### Refunds are not supported yet

Atoa switches refunds on per merchant account, and this module does not send
them. Pressing **Refund** on an order records it the way a bank transfer or a
cash order is recorded: the items come off the order, your books are credited
and the customer gets their credit note - but **the money is yours to send**,
from your own bank, the same way you would refund a bank transfer.

Nothing leaves your Atoa account by pressing that button. Automatic refunds are
a later release.

## Limits worth knowing

- **Pounds only.** Atoa is a UK provider; an order priced in anything else is
  refused rather than quietly charged in sterling.
- **£1.00 minimum.** Atoa rejects a payment below a pound.
- **30 characters** for the payment reference the payer sees.
- **Payment links expire.** Atoa's own default is three minutes, which is not
  enough time to open a banking app; this module sends 30 minutes unless you
  change it.
