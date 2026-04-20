FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# System deps — LibreOffice for DOCX rendering/editing via UNO bridge
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libreoffice-writer \
      python3 \
      python3-pip \
      python3-venv \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# uv — Python tool manager (installs headless-word CLI)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"
RUN uv tool install headless-word

# Bun runtime
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# App code (server bundle + workspace_tool.py are copied in by build script)
WORKDIR /home/user/app
COPY server.js .
COPY workspace_tool.py .
RUN mkdir -p workspaces
