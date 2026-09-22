# 视频号付费下载后端（纯 Node 进程，解析走自有远程服务 sph.yes-tek.com）
# 构建: docker build -t sph-pay-server ./server
# 默认走国内源加速；海外构建: --build-arg USE_CN_MIRROR=0
FROM node:22-slim

ARG USE_CN_MIRROR=1
ARG NPM_REGISTRY=https://registry.npmmirror.com

# apt 换阿里源（debian 12+ deb822 格式；旧格式回退 sources.list）
RUN if [ "$USE_CN_MIRROR" = "1" ]; then \
      f=/etc/apt/sources.list.d/debian.sources; \
      [ -f "$f" ] || f=/etc/apt/sources.list; \
      sed -i "s|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g" "$f"; \
    fi

# 证书 + 时区 + ffmpeg（A2M ¥1 打包交付：音频提取 m4a + ASR 转 wav 流）
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates tzdata ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖（层缓存友好）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry=$NPM_REGISTRY

COPY src ./src

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    DB_PATH=/app/data/orders.db

EXPOSE 8787
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
