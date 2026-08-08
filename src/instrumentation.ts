// Runs once when the Next.js server starts, before it accepts any requests
// -- see node_modules/next/dist/docs/.../instrumentation.md (this fork
// keeps the standard name/behavior; only middleware.ts was renamed to
// proxy.ts here). Split into a separate instrumentation-node.ts (imported
// only under the nodejs runtime) rather than importing "node:dns" directly
// in this file -- Next's bundler statically flags a Node-only module import
// here as an error under the Edge runtime it also builds this file for,
// even though the runtime check below would never actually execute it
// there; a build-time-analyzable conditional import is the officially
// documented way around that.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
