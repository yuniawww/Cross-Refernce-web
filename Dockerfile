# syntax=docker/dockerfile:1
# Override with a Bosch mirror of Ubuntu 22.04 when public registries are unavailable.
ARG UBUNTU_IMAGE=ubuntu:22.04
FROM ${UBUNTU_IMAGE} AS node-download
ARG TARGETARCH
ARG NODE_VERSION=22.23.3
ARG NODE_DIST_URL=https://nodejs.org/dist
RUN test "$TARGETARCH" = amd64 \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /download
RUN curl --fail --show-error --silent --location --retry 3 \
        "${NODE_DIST_URL}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o node.tar.xz \
    && curl --fail --show-error --silent --location --retry 3 \
        "${NODE_DIST_URL}/v${NODE_VERSION}/SHASUMS256.txt" -o SHASUMS256.txt \
    && mv node.tar.xz "node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && sha256sum --check --ignore-missing SHASUMS256.txt \
    && mkdir /opt/node \
    && tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /opt/node --strip-components=1

FROM ${UBUNTU_IMAGE} AS runtime-base
ARG TARGETARCH
RUN test "$TARGETARCH" = amd64 \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates tini libstdc++6 libgcc-s1 \
        libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdbus-1-3 \
        libdrm2 libxkbcommon0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
        libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libglib2.0-0 \
        libgtk-3-0 libpango-1.0-0 libpangocairo-1.0-0 libcairo2 libasound2 \
        fontconfig fonts-liberation fonts-wqy-zenhei \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 crawler \
    && useradd --uid 10001 --gid crawler --create-home --shell /bin/bash crawler
COPY --from=node-download /opt/node/ /usr/local/
WORKDIR /app

FROM runtime-base AS dependencies
ENV PUPPETEER_SKIP_DOWNLOAD=false \
    PUPPETEER_CHROME_SKIP_DOWNLOAD=false \
    PUPPETEER_CHROME_HEADLESS_SHELL_SKIP_DOWNLOAD=true
ARG PUPPETEER_CHROME_DOWNLOAD_BASE_URL
COPY package.json package-lock.json .puppeteerrc.cjs ./
# Optional npm credentials remain a BuildKit secret, never an image layer.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force
