// Parses the LLM's generated exercises (see EXERCISE_FORMAT_INSTRUCTIONS in
// prompts.ts) into question/solution pairs: exercises are separated by a
// line of three or more dashes, and within each block a line starting with
// "Q:" opens the question and a line starting with "A:" opens the solution
// -- either may span multiple lines, so the markers are what's parsed on,
// not line breaks.
const EXERCISE_BLOCK_PATTERN = /^Q:\s*([\s\S]*?)\r?\n^A:\s*([\s\S]*)$/im;

export function parseGeneratedExercises(text: string): { question: string; answer: string }[] {
  // Normalize CRLF/CR up front -- see the identical fix and reasoning in
  // src/app/admin/answer-bank/actions.ts's parseImportBlocks, which this
  // function is deliberately kept in sync with.
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split(/\n-{3,}\n/);
  const rows: { question: string; answer: string }[] = [];

  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;
    const match = block.match(EXERCISE_BLOCK_PATTERN);
    if (!match) continue;
    const question = match[1].trim();
    const answer = match[2].trim();
    if (!question || !answer) continue;
    rows.push({ question, answer });
  }

  return rows;
}
