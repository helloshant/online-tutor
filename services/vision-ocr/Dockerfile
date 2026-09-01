# TutorOps vision-ocr service. Owns image preprocessing + OCR (Image
# Processing -> Image-to-Text/Vision stages) for a scanned/photographed
# paper -- kept out of both the web app and the archetype-miner service so
# the Google Document AI credentials and the sharp/image-processing
# dependency live in exactly one place, mirroring services/archetype-miner
# (own pipeline, own cost profile, independently scalable/redeployable).

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
ENV PORT=4500

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 visionocr
COPY --from=builder --chown=visionocr:nodejs /app/dist ./dist

USER visionocr
EXPOSE 4500

CMD ["node", "dist/server.js"]
