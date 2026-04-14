FROM node:22-alpine AS base
RUN npm i -g pnpm

# ── Dependencies ─────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app

COPY pnpm-workspace.yaml ./
COPY package.json pnpm-lock.yaml ./
COPY packages/protocol/package.json ./packages/protocol/

RUN pnpm install --frozen-lockfile

# ── Builder ──────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY . .

# Protocol package is pre-built (dist/ included in context)

# Build Next.js (pages + SSR)
# Provide dummy secrets so build-time page collection doesn't crash
RUN JWT_SECRET=build-placeholder \
    AUTH_SECRET=build-placeholder \
    NEXTAUTH_SECRET=build-placeholder \
    DATABASE_URL=postgresql://placeholder:placeholder@localhost/placeholder \
    pnpm next build

# ── Runner ───────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy full source + node_modules (tsx transpiles on-the-fly)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/tsconfig.server.json ./

# Copy Next.js build output
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.ts ./

# Write build info
ARG GIT_SHA=""
ARG GIT_REF=""
ARG BUILD_NUMBER="0"
RUN node -e "const fs=require('fs'); fs.writeFileSync('public/build-info.json', JSON.stringify({gitSha:'${GIT_SHA}',ref:'${GIT_REF}',runNumber:Number('${BUILD_NUMBER}'||0),builtAt:new Date().toISOString()},null,2));"

EXPOSE 8080
ENV PORT=8080
ENV HOSTNAME="0.0.0.0"

CMD ["npx", "tsx", "src/server.ts"]
