// A small animated "typing" indicator -- three dots bouncing in a stagger,
// the same visual shorthand chat apps use for "the other side is working on
// a reply". Nothing in this app used a CSS animation before this component:
// every LLM-backed loading state (chat replies, topic summaries, topic
// exercises) previously fell back to plain static text ("Thinking…",
// "Generating summary…") with no motion at all, which reads as identical to
// a stalled/broken request once a generation takes more than a second or
// two. This doesn't replace those labels -- it decorates them, so the
// wording stays specific to what's actually being fetched while the motion
// itself is what actually communicates "still in progress" at a glance.
export function LoadingIndicator({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="flex items-center gap-0.5" aria-hidden="true">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current" />
      </span>
      <span>{label}</span>
    </span>
  );
}
