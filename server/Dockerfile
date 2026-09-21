# Build from the repository root:
#   docker build -f server/Dockerfile -t ai-browser-assistant-server .
# or simply `docker compose up`, which sets the context for you.

# ---- build stage -----------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Copy only the manifests first so dependency layers cache across code changes.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY extension/package.json extension/

# The extension workspace is not built here, so its dependencies are skipped.
RUN npm ci --workspace @ai-browser-assistant/server --include-workspace-root

COPY tsconfig.base.json ./
COPY server/ server/
RUN npm run build --workspace @ai-browser-assistant/server

# Drop dev dependencies from the tree that gets copied into the runtime image.
RUN npm prune --omit=dev --workspace @ai-browser-assistant/server --include-workspace-root

# ---- runtime stage ---------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

# npm workspaces hoist dependencies to the root, so there is a single
# node_modules tree to carry over.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist

# The node image ships a non-root `node` user; use it.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
