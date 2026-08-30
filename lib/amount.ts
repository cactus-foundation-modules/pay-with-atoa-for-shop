// Money, in the one unit Atoa actually uses.
//
// Atoa's `amount` is in MAJOR units - pounds with decimals, not pence. Proved
// in sandbox rather than read off a docs page, because the two readings differ
// by a hundredfold on live orders: a request sent as 1234 came back rendered by
// Atoa itself as "£1,234.00", and one sent as 12.34 as "£12.34". The shop hands
// over major units too (ShpOrderDraft.amount is commented "major currency
// units, e.g. 19.99"), so there is no conversion to do at all.
//
// What there IS to do is round. Atoa TRUNCATES a third decimal place rather
// than rounding it: 12.999 was rendered as £12.99. Any amount arriving with
// float dust on it - and floats produce dust - would be silently undercharged
// by up to a penny, and the settlement path's amount re-check would then fail
// against an order that says otherwise. Money taken, order not fulfilled. So we
// round to two places on our side before sending, and compare on the rounded
// value.

/** The figure as a whole number of pence, which is the only honest way to
 *  compare two decimal amounts for equality.
 *
 *  The toFixed step is not decoration. A bare Math.round(amount * 100) rounds
 *  the FLOAT rather than the number anybody wrote down: 1.005 * 100 is
 *  100.49999999999999 in binary, so a bare round gives 100 and quietly shaves
 *  off the penny that the truncation guard exists to protect. Rounding the
 *  product to six places first collapses the representation error before the
 *  half-up decision is made, and leaves every ordinary two-decimal amount
 *  exactly where it was. */
export function toPence(amount: number): number {
  return Math.round(Number((amount * 100).toFixed(6)))
}

/** The amount as Atoa will hold it: major units, two decimal places, rounded
 *  (not truncated) so nothing is quietly shaved off. */
export function roundToPennies(amount: number): number {
  return toPence(amount) / 100
}

// Atoa refuses an amount below 1 outright - "Amount must not be less than 1."
// with a 400, proved in sandbox. It applies to creating a payment, not only to
// refunding one, which is not something the documentation says anywhere. A shop
// selling anything under a pound (or taking a part payment under one) therefore
// cannot use this method for that order, and the shopper has to be told so in a
// sentence rather than shown a raw 400.
export const ATOA_MINIMUM_AMOUNT = 1

export function isBelowAtoaMinimum(amount: number): boolean {
  return roundToPennies(amount) < ATOA_MINIMUM_AMOUNT
}

// Atoa is a UK open-banking provider and takes pounds and nothing else. The
// `currency` field is not even a field on the create call: it is accepted and
// completely ignored, so an order priced in euros would be charged the same
// number in pounds. That is why this is a hard refusal rather than a
// best-effort conversion.
export const ATOA_CURRENCY = 'GBP'

export function isAtoaCurrency(currency: string): boolean {
  return currency.trim().toUpperCase() === ATOA_CURRENCY
}
