# Production image with the PDF tools the app shells out to: qpdf validates
# PDFs and runs Lossless mode, Ghostscript runs Balanced, Medium and Strong.
# Images and Office files are handled by npm packages and need nothing extra.

FROM node:24-slim AS base
WORKDIR /app

# Compilers are only here in case a native package has no prebuilt binary
FROM base AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS production-deps
RUN npm prune --omit=dev

FROM deps AS build
COPY . .
RUN node ace build

FROM base AS production
RUN apt-get update \
  && apt-get install -y --no-install-recommends qpdf ghostscript \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3333
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./
# Without TURSO_URL the stats database is tmp/db.sqlite3, and SQLite does
# not create missing folders
RUN mkdir -p tmp
EXPOSE 3333
# Migrations are idempotent, so running them on every start keeps the
# stats database in step with the code
CMD ["sh", "-c", "node ace migration:run --force && node bin/server.js"]
