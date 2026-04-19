# Legacy Lens - Docker Configuration
# Multi-stage build for production-ready deployment

# ==============================================================================
# Build Stage
# ==============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

# Copy package files and patches (patches must be copied before install)
COPY package.json pnpm-lock.yaml ./
COPY patches/ ./patches/

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build application (client + server)
RUN pnpm build

# ==============================================================================
# Production Stage
# ==============================================================================
FROM node:20-alpine AS production

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

# Copy package files and install production dependencies only
COPY package.json pnpm-lock.yaml ./
COPY patches/ ./patches/
RUN pnpm install --frozen-lockfile --prod

# Copy built assets from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Set ownership
RUN chown -R nodejs:nodejs /app

USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Start server
CMD ["node", "dist/index.js"]
