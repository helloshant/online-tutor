# SyllabusMate vision-ocr service. Owns image preprocessing + OCR (Image
# Processing -> Image-to-Text/Vision stages) for a scanned/photographed
# paper -- kept out of both the web app and the archetype-miner service so
# the Google Document AI credentials and the sharp/image-processing
# dependency live in exactly one place, mirroring services/archetype-miner
# (own pipeline, own cost profile, independently scalable/redeployable).

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Reported directly: a plain `npm ci` here installed BOTH the glibc
# (@img/sharp-linux-x64) and musl (@img/sharp-linuxmusl-x64) native sharp
# binaries side by side, even though this base image is alpine/musl-only --
# npm's platform auto-detection for optional dependencies isn't airtight
# inside Docker. Having the non-matching glibc one present at all is what
# then crashed sharp's own loader at startup ("Cannot read properties of
# undefined (reading 'endsWith')" in sharp.mjs) -- its fallback code breaks
# on an unexpected platform candidate before ever reaching the right one.
# --cpu/--os/--libc force npm to only ever consider this exact target,
# sharp's own officially documented fix for cross-platform Docker builds
# (https://sharp.pixelplumbing.com/install#cross-platform-build).
RUN npm ci --cpu=x64 --os=linux --libc=musl

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
# Same reasoning as the deps stage above -- this stage does its own
# separate (production-only) install, so needs the same explicit target.
RUN npm ci --omit=dev --cpu=x64 --os=linux --libc=musl

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 visionocr
COPY --from=builder --chown=visionocr:nodejs /app/dist ./dist

USER visionocr
EXPOSE 4500

CMD ["node", "dist/server.js"]
