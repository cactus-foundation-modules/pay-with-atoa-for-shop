-- Pay With Atoa for Shop - initial schema (prefix atp_).
-- All DDL idempotent so it is safe to re-run on every deploy, and so this file
-- stays correct for a fresh install once later numbered migrations exist.

-- Non-secret module settings (singleton). Credentials live in env vars
-- (ATOA_ACCESS_SECRET / ATOA_WEBHOOK_SIGNING_SECRET and their sandbox pair),
-- never in the database: the database is included in backups.
--
-- WHICH environment is live is a stored setting rather than an env var. An
-- environment variable on a hosted project does not reach the running server
-- until the next deployment, so choosing "Production" did nothing until a
-- redeploy, and the settings panel - reading back the environment the server
-- could actually see - snapped the dropdown straight back to Sandbox, which
-- looked for all the world like the save had failed. A stored setting takes
-- effect on the very next request. Sandbox is the fallback, because a
-- misconfigured shop should fail to take real money rather than take it by
-- accident.
CREATE TABLE IF NOT EXISTS "atp_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "payment_description" TEXT NOT NULL DEFAULT '',
    "environment" TEXT NOT NULL DEFAULT 'sandbox',
    -- Atoa's own default expiry is 3 minutes (expiresIn 180000 ms), which is
    -- nowhere near enough to open a banking app, authenticate and approve.
    -- Left alone it produces dead payment links as routine behaviour, so the
    -- module always sends expiresIn explicitly and never relies on the default.
    "expires_in_minutes" INTEGER NOT NULL DEFAULT 30,
    -- Atoa also does cards. Off by default: on this platform that job already
    -- belongs to another payment method, and turning it on drags in the
    -- AUTHORIZED/CANCELLED capture states. A setting rather than a hardcode
    -- because that is the platform rule.
    "allow_card" BOOLEAN NOT NULL DEFAULT false,
    -- The id of the webhook endpoint this site registered with Atoa over the
    -- API, so it can be replaced or removed later. NULL until the owner has
    -- registered one.
    "webhook_endpoint_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "atp_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "atp_settings_singleton" CHECK ("id" = 'singleton')
);
INSERT INTO "atp_settings" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING;

-- One row per checkout attempt: maps a shop order (or the draft it will be made
-- from) to its Atoa payment request.
CREATE TABLE IF NOT EXISTS "atp_payments" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "order_number" TEXT NOT NULL,
    "payment_request_id" TEXT,
    -- Atoa's hosted payment page for this request. Stored rather than rebuilt,
    -- because the URL carries base64 callbackParams we do not otherwise hold -
    -- and without it a shopper who double-submits cannot be handed back the
    -- payment request they already have, which is the only defence there is
    -- against creating two payment requests for one order (Atoa honours no
    -- idempotency key on create: proved, not assumed).
    "payment_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PAYMENT_NOT_INITIATED',
    -- Major units (pounds), which is what Atoa itself takes and returns.
    "amount" NUMERIC(12, 2) NOT NULL,
    "currency" TEXT NOT NULL,
    -- Where to put the payer down once Atoa hands them back. NULL means the
    -- shop's confirmation page, which is where a checkout payment belongs.
    -- Stored rather than carried in the return URL, deliberately: that URL
    -- comes back through the payer's own browser, so a destination read out of
    -- it is a destination anybody can write.
    "return_path" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "atp_payments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "atp_payments_order_id_idx" ON "atp_payments" ("order_id");
CREATE UNIQUE INDEX IF NOT EXISTS "atp_payments_payment_request_id_key"
    ON "atp_payments" ("payment_request_id");

-- DELIBERATELY UNUSED IN THIS RELEASE. Atoa provisions refunds per merchant
-- account and they are switched off on ours, so refunds are recorded by the
-- shop and the money is sent from the owner's own bank. The table is created
-- anyway: it costs an empty table, it keeps this file correct for a fresh
-- install, and it makes the release that turns refunds on a code change rather
-- than a code change plus a migration.
--
-- One row per shop refund row. The primary key IS the idempotency guard Atoa
-- does not give us: id = the shop's own refund row id, inserted BEFORE the call
-- goes out. A row that is already there means this refund has been sent once
-- already, and a second call would pay the customer twice.
CREATE TABLE IF NOT EXISTS "atp_refunds" (
    "id" TEXT NOT NULL,
    "payment_request_id" TEXT NOT NULL,
    "atoa_refund_id" TEXT,
    -- Major units, as above.
    "amount" NUMERIC(12, 2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INITIATED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "atp_refunds_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "atp_refunds_payment_request_id_idx"
    ON "atp_refunds" ("payment_request_id");
