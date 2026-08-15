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
