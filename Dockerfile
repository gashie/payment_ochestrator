# Orchestrator Service Dockerfile
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install dependencies for health checks
RUN apk add --no-cache curl

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Create logs directory
RUN mkdir -p logs

# Set user to non-root
RUN addgroup -g 1001 -S nodejs && \
    adduser -S orchestrator -u 1001 && \
    chown -R orchestrator:nodejs /app

USER orchestrator

# Expose port
EXPOSE 3002

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3002/health || exit 1

# Start application
CMD ["node", "src/app.js"]
