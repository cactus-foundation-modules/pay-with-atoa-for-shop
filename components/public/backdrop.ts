// Whether the page behind the payment fields is dark.
//
// COPIED, not imported, from square-payment-for-shop/components/public. This
// module declares a dependency on `shop` and nothing else, and importing from a
// sibling module would be an undeclared one - a shop with Atoa installed and
// Square not would be reaching for a file that is not on disk. The comments
// come across with it because they are the record of two shipped bugs, and the
// bugs are properties of the judgement rather than of Square.
//
// Its own file so it can be tested without dragging React and a payment SDK
// loader into a DOM test - this one judgement has now shipped the wrong answer
// in both directions (light fields on a dark checkout, then dark fields on a
// light one), so it is worth pinning down on its own.
//
// NOT the data-theme attribute: a site whose brand palette is dark paints a
// dark checkout while data-theme still says "light", and the question that
// decides the palette is what colour actually surrounds the fields. So: walk up
// from the container to the first element whose opaque background is the colour
// actually on screen, and measure that. The attribute is only the tie-breaker
// when nothing qualifying is found.
export function isDarkBackdrop(el: HTMLElement | null): boolean {
  for (let node = el; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    // An element painting an image or a gradient paints it OVER its own
    // background-color, so that colour is not what surrounds anything and
    // measuring it answers the wrong question. Keep walking.
    //
    // This is the whole bug, not a hypothetical: the site's <body> carries the
    // owner's Theme colour as its background-color - the tint the browser puts
    // in its own UI, which is very often a deep brand shade on an otherwise
    // white site - and paints a flat gradient of the real page colour over the
    // top. Measuring it turned every checkout on a dark-tinted site into a dark
    // card panel in broad daylight. Walking past it lands on the root element,
    // which carries the page colour itself and nothing else.
    if (style.backgroundImage && style.backgroundImage !== 'none') continue
    const bg = style.backgroundColor
    // Computed backgroundColor comes back as rgb()/rgba() in every browser this
    // runs in; anything else (a site whose tokens resolve to oklch, say) just
    // moves on up the tree, and out to the attribute if nothing else answers.
    // Guessing at a colour space we cannot read would be worse.
    const m = bg.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)/)
    if (!m) continue
    const alpha = m[4] === undefined ? 1 : parseFloat(m[4])
    if (alpha < 0.5) continue
    const lum = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255
    return lum < 0.5
  }
  return document.documentElement.getAttribute('data-theme') === 'dark'
}
