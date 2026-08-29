import { embed } from "./embeddingClient.js";
import type { ClusterInput, EducationContext, QuestionSignature } from "./types.js";

// This is the "pipeline/infra decision" v2 §5 calls out, not just a prompt
// instruction: clustering never mixes education_context scopes. Two
// signatures only ever land in the same cluster if their
// (education_stage, curriculum_source.type, curriculum_source.name,
// subject_or_course) tuple matches exactly -- grade_or_year and
// program_or_stream are deliberately NOT part of the scope key, since v2's
// own example (a reasoning skill recurring "from grade 9 through grade 11
// in slightly different guises") is exactly what the optional future
// ArchetypeFamily layer exists to relate ACROSS scopes, not something
// clustering should ever merge within one archetype by including it in
// the scope key.
export function scopeKey(ctx: EducationContext): string {
  return [ctx.education_stage, ctx.curriculum_source.type, ctx.curriculum_source.name, ctx.subject_or_course].join(
    "::"
  );
}

// The "signature" embedding basis from ClusterInput.embedding_basis:
// learning_objective + reasoning_pattern + abstract_structure -- explicitly
// NOT raw_text/cleaned_text, since the whole point of embedding on Stage
// 1's extracted fields rather than the question's own wording is that two
// questions with different surface wording but the same underlying
// reasoning should land close together, and two questions with similar
// wording but different reasoning should not (the same "ignore superficial
// wording" core principle Stage 1's own prompt states).
export function embeddingBasisText(sig: QuestionSignature): string {
  return [sig.learning_objective, sig.reasoning_pattern.join(" -> "), sig.abstract_structure].join("\n");
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function magnitude(a: number[]): number {
  return Math.sqrt(dot(a, a));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const denom = magnitude(a) * magnitude(b);
  return denom === 0 ? 0 : dot(a, b) / denom;
}

// Two signatures are linked (same connected component -> same cluster)
// once their embedding-basis cosine similarity crosses this bar. Tuned
// conservatively-high on purpose: a false SPLIT (two clusters that should
// have been one) is cheap to fix -- Stage 2's own cross-cluster check and
// Stage 3's MERGE decision both exist specifically to catch it -- while a
// false MERGE baked in at the clustering stage (two genuinely different
// reasoning patterns landing in one cluster) means Stage 2 has to
// correctly SPLIT them apart from raw text alone with no algorithmic
// signal pointing at the split, which is a strictly harder ask. Override
// via ARCHETYPE_CLUSTER_SIMILARITY_THRESHOLD if a corpus's own embedding
// distribution calls for it.
export function similarityThreshold(): number {
  const raw = Number(process.env.ARCHETYPE_CLUSTER_SIMILARITY_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.82;
}

// Plain union-find (path compression, no union-by-rank -- cluster counts
// here are small enough per run that the extra bookkeeping isn't worth
// it). Keyed by question_id.
class DisjointSet {
  private parent = new Map<string, string>();

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root) as string;
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur) as string;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export type ClusteringResult = {
  clusters: ClusterInput[];
  // question_id -> embedding, for pipelineRunner.ts to persist to
  // archetype_question_embeddings (kept out of this function's own
  // responsibility -- this module is pure computation, no DB access, same
  // separation the stage0-3 files keep).
  embeddingsByQuestionId: Map<string, number[]>;
  // Signatures whose scope's embedding call failed outright (VOYAGE_API_KEY
  // unset, or every retry in embeddingClient.ts exhausted) -- these never
  // got a chance to cluster at all. pipelineRunner.ts routes each straight
  // to the review queue (source: 'stage2_ambiguous_cluster') rather than
  // silently dropping them from the run.
  unembeddedQuestionIds: string[];
};

// Nearest-neighbor cluster lookup (ClusterDiagnostics.nearest_neighbor_clusters)
// -- gives Stage 2 a chance to catch "same archetype split across two
// clusters" without needing full cross-cluster memory (see the source
// doc's own reasoning). Computed from each cluster's centroid (mean
// member embedding), which is cheap since cluster COUNT is always far
// smaller than question count.
const NEAREST_NEIGHBOR_COUNT = 2;

function centroid(vectors: number[][]): number[] {
  const dim = vectors[0].length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) sum[i] += v[i];
  }
  return sum.map((s) => s / vectors.length);
}

function meanPairwiseCosine(vectors: number[][]): number {
  if (vectors.length < 2) return 1;
  let total = 0;
  let count = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      total += cosineSimilarity(vectors[i], vectors[j]);
      count++;
    }
  }
  return count === 0 ? 1 : total / count;
}

// Embeds every signature (scoped batches, one Voyage call per
// education_context scope) and groups them into clusters via threshold-
// based union-find over pairwise cosine similarity -- a real, if simple,
// clustering algorithm (not an LLM judgment; Stage 2 is where the actual
// reasoning-similarity judgment happens, working from these groupings and
// their diagnostics, per the source doc's "one judgment per stage"
// principle).
export async function clusterSignatures(
  signatures: QuestionSignature[],
  // Defaults to the real Voyage-backed embed() -- injectable so tests can
  // supply deterministic synthetic vectors without a live API key, and so
  // a caller batching an unusually large scope could swap in a
  // rate-limit-aware wrapper later without touching this function's own
  // grouping/clustering logic.
  embedFn: typeof embed = embed
): Promise<ClusteringResult> {
  const byScope = new Map<string, QuestionSignature[]>();
  for (const sig of signatures) {
    const key = scopeKey(sig.education_context);
    const list = byScope.get(key);
    if (list) list.push(sig);
    else byScope.set(key, [sig]);
  }

  const clusters: ClusterInput[] = [];
  const embeddingsByQuestionId = new Map<string, number[]>();
  const unembeddedQuestionIds: string[] = [];
  let clusterCounter = 0;

  for (const scopedSignatures of byScope.values()) {
    const texts = scopedSignatures.map(embeddingBasisText);
    const embeddings = await embedFn(texts, "document");
    if (!embeddings) {
      unembeddedQuestionIds.push(...scopedSignatures.map((s) => s.question_id));
      continue;
    }

    const byId = new Map(scopedSignatures.map((s, i) => [s.question_id, s]));
    const vectorById = new Map(scopedSignatures.map((s, i) => [s.question_id, embeddings[i]]));
    for (const [id, vec] of vectorById) embeddingsByQuestionId.set(id, vec);

    const threshold = similarityThreshold();
    const ds = new DisjointSet();
    for (const s of scopedSignatures) ds.find(s.question_id);
    for (let i = 0; i < scopedSignatures.length; i++) {
      for (let j = i + 1; j < scopedSignatures.length; j++) {
        const idA = scopedSignatures[i].question_id;
        const idB = scopedSignatures[j].question_id;
        if (cosineSimilarity(vectorById.get(idA) as number[], vectorById.get(idB) as number[]) >= threshold) {
          ds.union(idA, idB);
        }
      }
    }

    const groupsByRoot = new Map<string, string[]>();
    for (const s of scopedSignatures) {
      const root = ds.find(s.question_id);
      const group = groupsByRoot.get(root);
      if (group) group.push(s.question_id);
      else groupsByRoot.set(root, [s.question_id]);
    }

    const scopeClusters: { cluster_id: string; memberIds: string[]; memberVectors: number[][]; centroidVec: number[] }[] =
      [];
    for (const memberIds of groupsByRoot.values()) {
      clusterCounter++;
      const cluster_id = `cluster-${clusterCounter}`;
      const memberVectors = memberIds.map((id) => vectorById.get(id) as number[]);
      scopeClusters.push({ cluster_id, memberIds, memberVectors, centroidVec: centroid(memberVectors) });
    }

    for (const c of scopeClusters) {
      const neighbors = scopeClusters
        .filter((other) => other.cluster_id !== c.cluster_id)
        .map((other) => ({ id: other.cluster_id, sim: cosineSimilarity(c.centroidVec, other.centroidVec) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, NEAREST_NEIGHBOR_COUNT)
        .map((n) => n.id);

      clusters.push({
        cluster_id: c.cluster_id,
        education_context: (byId.get(c.memberIds[0]) as QuestionSignature).education_context,
        embedding_basis: "signature",
        member_signatures: c.memberIds.map((id) => byId.get(id) as QuestionSignature),
        cluster_diagnostics: {
          intra_cluster_cohesion: meanPairwiseCosine(c.memberVectors),
          nearest_neighbor_clusters: neighbors,
        },
      });
    }
  }

  return { clusters, embeddingsByQuestionId, unembeddedQuestionIds };
}
