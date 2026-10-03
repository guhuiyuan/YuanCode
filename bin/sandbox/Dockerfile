# =============================================================================
# YuanCode sandbox image
# Built once with:  docker build -t yuancode/sandbox:latest bin/sandbox/
# Used by YUANCODE_SANDBOX=docker mode to run agent shell commands in
# an isolated container that mounts the project as /workspace.
# =============================================================================
FROM node:20-bookworm-slim

# Minimal toolchain for the agent. Add build tools only when needed;
# keep the image small to avoid slow `docker build`.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    ripgrep \
    python3 \
    bash \
    coreutils \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user so the agent cannot accidentally write as root.
RUN useradd --create-home --uid 1000 yuancode
USER yuancode
WORKDIR /home/yuancode

# Container entrypoint: simply run whatever the harness asks for.
# The harness passes `["bash", "-c", "<cmd>"]` and binds the host cwd to /workspace.
ENTRYPOINT ["/bin/bash", "-c"]
CMD ["echo yuancode sandbox ready"]
