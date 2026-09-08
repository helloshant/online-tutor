"use client";

// The board/grade/subject filter on the coverage and cross-run-merge pages
// is a plain GET <form> -- submitting requires an explicit "Check" click.
// getArchetypeFilterOptions() cascades grades off the chosen board and
// subjects off the chosen board+grade, but that cascade only happens on
// the NEXT page load: change Grade from 10 to 12 without resubmitting and
// the Subject dropdown still shows whatever list was rendered for Grade
// 10, since the DOM hasn't been told otherwise yet. Confirmed as the real
// cause of "for grade 12, the Subjects remains same as grade 10" -- the
// underlying data and cascade logic were already correct, the dropdown
// itself just hadn't been asked to refresh.
//
// This submits the form the moment Board or Grade changes, so the option
// list the admin actually sees is always the one that matches their
// current selection. `clearFieldNames` blanks out any downstream select
// (Subject depends on Grade, both depend on Board) before submitting --
// otherwise a stale value from the old scope (e.g. a Grade-10-only
// subject) would ride along into the new scope and silently produce zero
// results instead of prompting a fresh pick. Still a native <select> under
// the hood, so it degrades to the ordinary "pick everything, then click
// Check" flow if JS is unavailable.
export function AutoSubmitSelect({
  clearFieldNames = [],
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { clearFieldNames?: string[] }) {
  return (
    <select
      {...props}
      onChange={(e) => {
        const form = e.currentTarget.form;
        if (form) {
          for (const name of clearFieldNames) {
            const field = form.elements.namedItem(name);
            if (field instanceof HTMLSelectElement) field.value = "";
          }
        }
        form?.requestSubmit();
      }}
    />
  );
}
