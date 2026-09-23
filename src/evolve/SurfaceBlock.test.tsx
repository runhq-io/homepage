import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SurfaceBlock } from './SurfaceBlock';

/**
 * While a consented visitor's surface is pending (≤ 400 ms) the block keeps the
 * shipped copy's box — invisible, but laid out — so nothing below it moves
 * when the arm replaces it.
 */
describe('SurfaceBlock', () => {
  it('lays out the default copy invisibly while pending', () => {
    expect(
      renderToStaticMarkup(
        <SurfaceBlock className="rhw-hero-side" settled={false}><h1>Signal-to-code.</h1></SurfaceBlock>,
      ),
    ).toBe('<div class="rhw-hero-side" style="visibility:hidden" aria-busy="true"><h1>Signal-to-code.</h1></div>');
  });

  it('is a plain block once settled', () => {
    expect(
      renderToStaticMarkup(
        <SurfaceBlock className="rhw-hero-side" settled><h1>Signal-to-code.</h1></SurfaceBlock>,
      ),
    ).toBe('<div class="rhw-hero-side"><h1>Signal-to-code.</h1></div>');
  });
});
