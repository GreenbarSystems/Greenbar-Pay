# Web image (Next.js). The worker is built separately from Dockerfile.worker
# which skips `next build` and copies only src/{db,jobs,lib} + scripts.
# Multi-stage to keep the runtime image small.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# `postinstall` (scripts/copy-pdf-worker.mjs, scripts/setup-hooks.mjs)
# runs as part of `npm install` below and requires scripts/ to already
# exist -- without this COPY, install fails with MODULE_NOT_FOUND
# (pre-existing bug, unrelated to F5/F6, caught by adding a real
# `docker build` to CI as part of this PR's verification work).
COPY scripts ./scripts
RUN npm install --no-audit --no-fund

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# tesseract.js downloads language data on first run; cache it in /app/.tesseract
ENV TESSDATA_PREFIX=/app/.tesseract
# poppler-utils provides pdftoppm, used by the PDF rasterization fallback
# (src/lib/ocr/pdf-rasterize.ts). ~10 MB; well worth the cost vs. canvas
# native bindings.
RUN apk add --no-cache poppler-utils
COPY --from=build /app .
# F5 fix (2026-07-12 security audit): don't run as root. This image
# parses untrusted, user-uploaded PDFs and emailed attachments via
# pdftoppm/tesseract — a parser bug there shouldn't hand an attacker a
# root shell in the container. node:20-alpine ships a non-root `node`
# user (uid/gid 1000) built in; `chown` is needed because COPY defaults
# to root ownership and tesseract.js/Next.js write to /app at runtime
# (tesseract language-data cache, .next/cache).
RUN chown -R node:node /app
USER node
EXPOSE 3000
# Override the command in docker-compose for the worker service.
CMD ["npm", "start"]
