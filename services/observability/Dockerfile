# TutorOps observability service. Owns how orchestrator answer-pipeline
# events (cache/database/llm/rejected hits) get recorded and priced --
# kept as its own container so ingestion and future analytics/retention
# jobs can be scaled or redeployed independently of the orchestrator.

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
ENV PORT=4100

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 observability
COPY --from=builder --chown=observability:nodejs /app/dist ./dist

USER observability
EXPOSE 4100

CMD ["node", "dist/server.js"]
