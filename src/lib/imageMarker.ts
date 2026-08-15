// Shared between the Answer Bank bulk-import parser (actions.ts, a "use
// server" file that can only export async Server Actions, hence this can't
// live there) and the rendering side (text-with-inline-images.tsx) -- a
// single Unicode Private Use Area code point standing in, inline, for
// wherever an "IMG:" line appeared in the original bulk-import text, so a
// render pass can place each image exactly where its line was instead of
// always trailing at the end. PUA code points are reserved specifically for
// this kind of private/internal use and are guaranteed never to appear in
// real document text, so splitting on it can never misfire on genuine
// content.
export const IMAGE_MARKER = "";

// The Edit form's <textarea> can neither display nor let someone type
// IMAGE_MARKER's invisible PUA character, so editAnswer (actions.ts) uses
// this human-typeable stand-in instead: "[IMAGE N]" always means "this
// row's Nth currently-attached image" (1-based, plain image_urls array
// order) -- not "the Nth marker specifically," since an image attached the
// old flat/per-row way (addImage, no marker at all) is just as
// repositionable this way as one that already has a marker. A brand-new
// image being added in the same edit still uses the bulk import's own
// "IMG: filename.png" line, referencing a file picked in the edit form's
// own file input, not this placeholder (which only ever refers to an
// image that already exists on the row).
export const IMAGE_PLACEHOLDER_PATTERN = /\[IMAGE (\d+)\]/g;

// Populates the Edit form's textareas: every real marker becomes
// "[IMAGE N]", numbered by its position among *all* markers found (both
// question and answer, in that order) -- matching how
// text-with-inline-images.tsx's splitInlineImages recovers the
// question/answer split from a flat image_urls array in the first place,
// so "[IMAGE N]" and "the Nth entry of image_urls" agree here too.
export function markersToPlaceholders(text: string): string {
  let index = 0;
  return Array.from(text)
    .map((ch) => (ch === IMAGE_MARKER ? `[IMAGE ${++index}]` : ch))
    .join("");
}
