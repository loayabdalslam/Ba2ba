# Gateway (OpenAI-compatible API over the mesh). Build from the repository root:
#   docker build -f gateway/Dockerfile -t bee2bee-gateway .
FROM node:22-slim AS deps
WORKDIR /gateway
COPY gateway/package.json gateway/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-slim
ENV NODE_ENV=production PORT=3001 GATEWAY_KEY_FILE=/data/gateway_key.pem
WORKDIR /gateway
COPY --from=deps /gateway/node_modules ./node_modules
COPY gateway/package.json ./
COPY gateway/src ./src
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
