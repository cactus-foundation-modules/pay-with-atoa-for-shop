// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { isDarkBackdrop } from '@/modules/pay-with-atoa-for-shop/components/public/backdrop'

// Copied alongside the function it covers (see backdrop.ts): a copy without its
// test is a copy nobody would notice going wrong. This one judgement has been
// wrong in both directions in the wild - once leaving light fields marooned on
// a dark checkout, once painting a dark panel on a perfectly white one. Both
// cases are pinned here.

function nest(...styles: string[]): HTMLElement {
  // Outermost first, so the list reads the way the page does: <html> at the
  // front, the payment fields' own parent at the end.
  let node: HTMLElement = document.documentElement
  document.documentElement.removeAttribute('style')
  document.body.removeAttribute('style')
  for (const [i, style] of styles.entries()) {
    const el = i === 0 ? document.documentElement : i === 1 ? document.body : document.createElement('div')
    if (el.parentElement !== node && el !== document.documentElement) node.appendChild(el)
    el.setAttribute('style', style)
    node = el
  }
  const leaf = document.createElement('div')
  node.appendChild(leaf)
  return leaf
}

afterEach(() => {
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('data-theme')
  document.body.removeAttribute('style')
  document.body.replaceChildren()
})

describe('isDarkBackdrop', () => {
  it('reads a plain white page as light', () => {
    expect(isDarkBackdrop(nest('background-color: #ffffff'))).toBe(false)
  })

  it('reads a plain dark page as dark', () => {
    expect(isDarkBackdrop(nest('background-color: #16181a'))).toBe(true)
  })

  // The regression: <body> carries the owner's Theme colour - the browser-UI
  // tint, often a deep brand shade - and paints the real page colour over it as
  // a gradient. Measuring the colour under the paint made every checkout on a
  // dark-tinted site draw a dark card panel in the middle of a white page.
  it('ignores a background-colour that a gradient is painted over', () => {
    const leaf = nest(
      'background-color: #ffffff',
      'background-color: #1b3e44; background-image: linear-gradient(#ffffff, #ffffff)',
    )
    expect(isDarkBackdrop(leaf)).toBe(false)
  })

  // The mirror of it: the same tint on a site that really is dark must not be
  // allowed to answer either, and the page colour underneath still must.
  it('still finds the page colour when the tint sits on a dark site', () => {
    const leaf = nest(
      'background-color: #16181a',
      'background-color: #1b3e44; background-image: linear-gradient(#16181a, #16181a)',
    )
    expect(isDarkBackdrop(leaf)).toBe(true)
  })

  // A dark panel drawn by the site itself is nearer than the page, and wins.
  it('measures the nearest opaque surface, not the page behind it', () => {
    const leaf = nest('background-color: #ffffff', 'background-color: #ffffff', 'background-color: #1c1c1e')
    expect(isDarkBackdrop(leaf)).toBe(true)
  })

  it('walks past a nearly transparent surface', () => {
    const leaf = nest('background-color: #16181a', 'background-color: #16181a', 'background-color: rgba(255,255,255,0.04)')
    expect(isDarkBackdrop(leaf)).toBe(true)
  })

  // Nothing measurable anywhere - a site whose tokens resolve to a colour
  // space this cannot read - falls back to what the page says about itself.
  it('falls back to data-theme when nothing opaque can be read', () => {
    document.documentElement.setAttribute('data-theme', 'dark')
    const leaf = document.createElement('div')
    document.body.appendChild(leaf)
    expect(isDarkBackdrop(leaf)).toBe(true)
    document.documentElement.setAttribute('data-theme', 'light')
    expect(isDarkBackdrop(leaf)).toBe(false)
  })
})
