// Inline pages for spec 209's scroll and helper probes, served by the fixture
// server next to the fixture app. In the first viewport (1280×720): three
// scroll containers and a plain, non-scrollable box; below them, a spacer that
// makes the page scroll, and the `x` element `scrollIntoViewIfNeeded` reaches.

const box = 'height:120px;width:300px;margin:8px;';
const container = `${box}overflow-y:auto;border:1px solid #888;`;
const tall = (px: number) => `<div style="height:${px}px">content</div>`;

const scrolls = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>scrolls</title></head>
  <body style="margin:0">
    <div id="by-id" style="${container}">${tall(600)}</div>
    <div class="anonymous" style="${container}">${tall(600)}</div>
    <div data-testid="long-log" style="${container}">${tall(10_000)}</div>
    <div id="plain" style="${box}background:#eee">not scrollable</div>
    <div style="height:3000px"></div>
    <div data-testid="x">x</div>
  </body>
</html>
`;

const buttons = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>buttons</title></head>
  <body>
    <button type="button">Add to cart</button>
    <button type="button">Checkout</button>
  </body>
</html>
`;

export const INLINE_PAGES: Readonly<Record<string, string>> = {
  '/inline/scrolls': scrolls,
  '/inline/buttons': buttons,
};
