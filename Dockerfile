# NanoClaw Orchestrator Container
# Runs the NanoClaw Node.js service with gVisor (runsc) for subagent isolation.
# Each subagent runs inside gVisor's Sentry VM — syscalls are intercepted by
# gVisor's user-space kernel rather than reaching the host kernel directly.
# bubblewrap is also installed as a fallback (CONTAINER_RUNTIME=bwrap).

FROM node:22-slim

# ── System packages ──────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    # Sandbox runtimes
    bubblewrap \
    # gVisor prerequisites
    apt-transport-https \
    ca-certificates \
    gnupg \
    # Chromium for browser automation inside sandboxes
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

# ── gVisor (runsc) ───────────────────────────────────────────────────────────
# Installs runsc from Google's official apt repository.
# runsc is the gVisor container runtime — it intercepts all subagent syscalls
# through a user-space kernel (the "Sentry"), providing a VM-level isolation
# boundary without requiring full hardware virtualisation.
RUN curl -fsSL https://gvisor.dev/archive.key \
      | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] \
        https://storage.googleapis.com/gvisor/releases release main" \
      > /etc/apt/sources.list.d/gvisor.list \
    && apt-get update \
    && apt-get install -y runsc \
    && rm -rf /var/lib/apt/lists/*

# Chromium path for agent-browser tool used inside sandboxes
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install global tools available inside sandboxes (visible via root fs bind)
RUN npm install -g agent-browser @anthropic-ai/claude-code

# ── Orchestrator ─────────────────────────────────────────────────────────────
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

# ── Agent-runner (pre-compiled; sandboxes run dist/ directly) ────────────────
WORKDIR /opt/agent-runner
COPY container/agent-runner/package*.json ./
RUN npm install
COPY container/agent-runner/ ./
RUN npx tsc

# ── Directory scaffolding for sandbox bind-mount targets ─────────────────────
# These paths must exist in the image so bind mounts can overlay them.
RUN mkdir -p \
    /workspace/group \
    /workspace/global \
    /workspace/extra \
    /workspace/ipc/messages \
    /workspace/ipc/tasks \
    /workspace/ipc/input \
    /home/node

# ── Runtime ──────────────────────────────────────────────────────────────────
WORKDIR /app

# Use gVisor for subagent isolation by default.
# Override:
#   CONTAINER_RUNTIME=bwrap   — use bubblewrap instead (namespace-based, no SYS_PTRACE needed)
#   CONTAINER_RUNTIME=docker  — use Docker (bare-metal installs without /.dockerenv)
ENV CONTAINER_RUNTIME=gvisor

# gVisor platform (ptrace works in Docker with SYS_PTRACE; kvm needs /dev/kvm)
ENV GVISOR_PLATFORM=ptrace

ENTRYPOINT ["node", "dist/index.js"]
