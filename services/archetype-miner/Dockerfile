# TutorOps archetype-miner service. Owns the 5-stage question-archetype
# pipeline (Segmenter -> Analyzer -> embed/cluster -> Miner -> Critic) that
# turns a historical question corpus into a reusable archetype taxonomy --
# batch/analytical work with its own LLM+embedding cost profile and its
# own long-running pipeline runs, kept out of the orchestrator (which owns
# the live student-facing chat path) so a slow or failed mining run can
# never affect it, and so this service can be scaled/redeployed
# independently, mirroring services/observability.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4400

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 archetypeminer
COPY --from=builder --chown=archetypeminer:nodejs /app/dist ./dist

USER archetypeminer
EXPOSE 4400

CMD ["node", "dist/server.js"]
