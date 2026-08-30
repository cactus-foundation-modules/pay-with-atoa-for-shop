-- Where the shopper authorises the payment: on Atoa's own hosted page (a
-- redirect away and back), or in Atoa's dialog opened over this site's own
-- checkout.
--
-- A NEW numbered file rather than an edit to 001. Editing 001 in place never
-- re-runs on an install that already has it, so the column would exist on fresh
-- installs and nowhere else - which is exactly how a live site once ended up
-- missing a table. 001 stays correct for a fresh install on its own; the DDL
-- here is idempotent, so the overlap is harmless.
--
-- Defaults to 'redirect', and anything unrecognised reads as 'redirect' in the
-- code as well (see toPaymentEntry in lib/settings.ts). It has to: the on-page
-- dialog only loads on a domain that has been whitelisted in the Atoa dashboard,
-- and no existing shop has been asked to do that - so a default of 'on-page'
-- would have switched a working payment method off on somebody's live shop the
-- moment they updated the module.
ALTER TABLE "atp_settings" ADD COLUMN IF NOT EXISTS "payment_entry" TEXT
    NOT NULL DEFAULT 'redirect';

-- Dropped and re-added rather than added conditionally, so re-running this file
-- lands on exactly one constraint of exactly this shape.
ALTER TABLE "atp_settings" DROP CONSTRAINT IF EXISTS "atp_settings_payment_entry_check";
ALTER TABLE "atp_settings" ADD CONSTRAINT "atp_settings_payment_entry_check"
    CHECK ("payment_entry" IN ('redirect', 'on-page'));
