# ---------- Build stage ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Prisma's schema engine (used by `prisma db push` / `migrate`) needs OpenSSL
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json prisma7.config.ts ./
COPY prisma ./prisma
COPY src ./src

RUN npx prisma generate --config prisma7.config.ts \
  && npm run build

# ---------- Runtime stage ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
