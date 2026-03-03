# NanoClaw Orchestrator Container
# Runs the NanoClaw Node.js service with bubblewrap for subagent isolation.
# Subagents are sandboxed via bwrap rather than nested Docker containers.

FROM node:22-slim

# bubblewrap for subagent isolation + chromium for browser automation in sandboxes
RUN apt-get update && apt-get install -y \
    bubblewrap \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Chromium path for agent-browser tool used inside bwrap sandboxes
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install global tools available inside bwrap sandboxes (shared ro-bind from /)
RUN npm install -g agent-browser @anthropic-ai/claude-code

# ── Orchestrator ────────────────────────────────────────────────────────────
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

# ── Agent-runner (pre-compiled; bwrap sandboxes run dist/ directly) ─────────
WORKDIR /opt/agent-runner
COPY container/agent-runner/package*.json ./
RUN npm install
COPY container/agent-runner/ ./
RUN npx tsc

# ── Directory scaffolding for bwrap bind-mount targets ──────────────────────
# These paths must exist in the image so bwrap can bind-mount over them.
RUN mkdir -p \
    /workspace/group \
    /workspace/global \
    /workspace/extra \
    /workspace/ipc/messages \
    /workspace/ipc/tasks \
    /workspace/ipc/input \
    /home/node

# ── Runtime ─────────────────────────────────────────────────────────────────
WORKDIR /app

# Tells NanoClaw to use bwrap for subagents instead of docker.
# Can be overridden with CONTAINER_RUNTIME=docker for bare-metal installs.
ENV CONTAINER_RUNTIME=bwrap

ENTRYPOINT ["node", "dist/index.js"]
