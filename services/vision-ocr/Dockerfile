# SyllabusMate vision-ocr service. Owns image preprocessing + OCR (Image
# Processing -> Image-to-Text/Vision stages) for a scanned/photographed
# paper -- kept out of both the web app and the archetype-miner service so
# the Google Document AI credentials and the sharp/image-processing
# dependency live in exactly one place, mirroring services/archetype-miner
# (own pipeline, own cost profile, independently scalable/redeployable).

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# sharp is pinned to 0.32.6 in package.json (not a caret range) -- newer
# sharp's prebuilt Linux x64 binaries require "v2" microarchitecture CPU
# features (SSE4.2/POPCNT and similar), and at least one real deployment
# target's virtualized CPU (confirmed directly via /proc/cpuinfo) doesn't
# expose them, crashing sharp outright with "Unsupported CPU" at startup.
# 0.32.6 is the last version built against the older libvips baseline that
# doesn't have this requirement. Its own install mechanism (prebuild-install,
# a postinstall script) also auto-detects this container's platform/libc
# correctly at install time -- unlike newer sharp's declarative
# @img/sharp-* optionalDependencies scheme, which (separately, confirmed
# directly before landing on this fix) installed both the glibc and musl
# native binaries side by side on this same alpine base image, crashing
# sharp's own loader a different way. No special install flags needed
# here either way.
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
