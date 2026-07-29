# TutorOps payment service. Owns everything about turning a pending
# subscription into an active one: the CCAvenue integration (request
# encryption, callback decryption/verification) and one-time coupon-code
# generation/redemption. Kept as its own container -- separate from the web
# app and the orchestrator -- so the money-handling surface has its own
# deploy lifecycle, its own credentials, and doesn't share a process with
# anything that talks to an LLM.

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
ENV PORT=4200

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 payment
COPY --from=builder --chown=payment:nodejs /app/dist ./dist

USER payment
EXPOSE 4200

CMD ["node", "dist/server.js"]
