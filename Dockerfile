# Single image for both web and worker — they share the same source tree and
# only the entrypoint differs. Multi-stage to keep the runtime image small.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
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
COPY --from=build /app .
EXPOSE 3000
# Override the command in docker-compose for the worker service.
CMD ["npm", "start"]
