# TutorOps broadcast service. Owns the two operations around admin
# broadcasts (announcements/promotions/feedback requests/tests) that
# shouldn't trust a client: resolving which students a broadcast's
# board/grade/subject/medium filter actually reaches, and scoring a
# submitted test. Everything else (authoring a draft, listing broadcasts,
# reading an inbox, submitting feedback) is plain CRUD the web app already
# handles itself via its service-role admin client, the same way
# coupon_codes/answered_questions/topic_summaries are -- kept out of this
# service so it stays small and focused, mirroring services/payment.

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
ENV PORT=4300

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 broadcast
COPY --from=builder --chown=broadcast:nodejs /app/dist ./dist

USER broadcast
EXPOSE 4300

CMD ["node", "dist/server.js"]
