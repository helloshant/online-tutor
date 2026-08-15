import { IMAGE_MARKER } from "@/lib/imageMarker";
import { MathText } from "./math-text";

// Splits `question`/`answer` on IMAGE_MARKER once, up front, so both
// Practice panel and the admin Answer Bank list can pass the right slice
// of a row's flat image_urls to each of TextWithInlineImages's two calls
// without duplicating the marker-counting logic themselves. Markers were
// written in question-then-answer order by the bulk import (see
// actions.ts), so the first `questionMarkerCount` entries of image_urls
// always belong to the question and the rest to the answer -- nothing
// extra needs to be stored to recover that split.
export function splitInlineImages(
  question: string,
  answer: string,
  imageUrls: string[]
): { questionImages: string[]; answerImages: string[] } {
  let questionMarkerCount = 0;
  for (const ch of question) if (ch === IMAGE_MARKER) questionMarkerCount++;
  return {
    questionImages: imageUrls.slice(0, questionMarkerCount),
    answerImages: imageUrls.slice(questionMarkerCount),
  };
}

// Renders text that may contain IMAGE_MARKER placeholders (left by the
// Answer Bank bulk import's inline "IMG:" lines, see actions.ts) by
// splitting on them and interleaving each corresponding image from
// `imageUrls`, in order, right at that point in the text -- instead of
// always trailing every image after the text the way a flat list would.
// Any imageUrls beyond the number of markers found (the common case: a row
// added before this feature existed, or an image attached the normal
// per-row way via addImage, which never inserts a marker at all) render as
// a trailing block after everything else -- exactly the old, marker-free
// behavior, so this is a strict superset rather than a breaking change for
// existing content.
export function TextWithInlineImages({
  text,
  imageUrls,
  imageClassName,
}: {
  text: string;
  imageUrls: string[];
  imageClassName: string;
}) {
  const segments = text.split(IMAGE_MARKER);
  const inlineCount = Math.min(segments.length - 1, imageUrls.length);
  const trailing = imageUrls.slice(inlineCount);

  return (
    <>
      {segments.map((segment, i) => (
        <span key={i}>
          {segment.trim() && <MathText text={segment} />}
          {i < inlineCount && (
            // eslint-disable-next-line @next/next/no-img-element -- external Supabase Storage URL, not a local/optimizable asset
            <img src={imageUrls[i]} alt="Figure for this question" className={imageClassName} />
          )}
        </span>
      ))}
      {trailing.map((url) => (
        // eslint-disable-next-line @next/next/no-img-element -- external Supabase Storage URL, not a local/optimizable asset
        <img key={url} src={url} alt="Figure for this question" className={imageClassName} />
      ))}
    </>
  );
}
