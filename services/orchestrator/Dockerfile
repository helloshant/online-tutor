# TutorOps LLM orchestration service. Owns system-prompt construction,
# syllabus-relevance filtering, and LLM provider selection (Anthropic /
# Azure OpenAI); kept as its own container so the provider/prompt layer can
# be scaled, redeployed, or swapped independently of the web app.

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
ENV PORT=4000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 orchestrator
COPY --from=builder --chown=orchestrator:nodejs /app/dist ./dist

USER orchestrator
EXPOSE 4000

CMD ["node", "dist/server.js"]
