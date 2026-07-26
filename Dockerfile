# TutorOps web app (Next.js). The LLM orchestration service lives in a
# separate image -- see services/orchestrator/Dockerfile -- this container
# never talks to an LLM SDK directly, only to the orchestrator over HTTP.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# No env vars needed at build time: every route that touches Supabase,
# Razorpay, or the orchestrator is dynamic (server-rendered per request),
# not statically prerendered, so `next build` never evaluates them. Real
# values are supplied at container runtime instead (docker-compose.yml).
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
