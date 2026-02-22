FROM node:20-slim AS base

# Install Playwright system dependencies
RUN apt-get update && apt-get install -y \
    libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ─── Dependencies ────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
RUN npx playwright install chromium

# ─── Build ───────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ─── Production ──────────────────────────────────────────────
FROM base AS production
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /root/.cache/ms-playwright /root/.cache/ms-playwright
COPY --from=build /app/dist ./dist
COPY package.json ./

# Run as non-root for security (sandboxing)
RUN groupadd -r agent && useradd -r -g agent agent
USER agent

EXPOSE 3000
CMD ["node", "dist/index.js"]
