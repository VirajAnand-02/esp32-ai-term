FROM node:22-slim

# ffmpeg is the whole reason for this image. ca-certificates is needed to fetch yt-dlp.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# yt-dlp next to the server: resolveYtDlp() checks ./yt-dlp before falling back to PATH.
# The _linux build is self-contained, so no Python is needed in the image.
RUN curl -fsSL -o /app/yt-dlp \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
    && chmod +x /app/yt-dlp

RUN corepack enable

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Render injects PORT; server.ts reads it and falls back to 3000.
EXPOSE 3000
CMD ["pnpm", "start"]
