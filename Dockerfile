# Playwright's image ships Chromium and its system libraries: the preview renderer needs them.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY phone/package.json phone/
COPY agent/package.json agent/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund
ENV NODE_ENV=production
CMD ["node", "server/dist/server/src/index.js"]
