FROM node:22.19-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
RUN npm ci && npm run build && npm prune --omit=dev && mkdir /app/data

FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167
ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE_URL=https://github.com/Sunnyender-org/cursor-sdk2api
WORKDIR /app
ENV NODE_ENV=production
ENV GATEWAY_VERSION=${VERSION}
LABEL org.opencontainers.image.title="cursor-sdk2api" \
      org.opencontainers.image.description="Official Cursor SDK gateway with Anthropic and OpenAI compatible APIs" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="MIT"
COPY --from=build --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /app/dist ./dist
COPY --from=build --chown=65532:65532 /app/data /data
COPY --chown=65532:65532 LICENSE NOTICE.md README.md README.zh-CN.md ./
ENV STATE_DIR=/data
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["dist/index.js"]
