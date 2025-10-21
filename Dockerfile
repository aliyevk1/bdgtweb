# ---- Build dependencies stage ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev


# ---- Runtime stage ----
FROM node:20-alpine AS runner
ENV NODE_ENV=production \
PORT=3000 \
DATABASE_PATH=/data/budget.db


# Create a non-root user and data dir
RUN addgroup -S app && adduser -S app -G app \
&& mkdir -p /app /data \
&& chown -R app:app /app /data


WORKDIR /app


# Copy installed modules and app source
COPY --from=deps /app/node_modules ./node_modules
COPY . .


# Expose the web port
EXPOSE 3000


# Optional healthcheck (requires curl)
RUN apk add --no-cache curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
CMD curl -fsS http://localhost:${PORT}/ || exit 1


USER app
CMD ["node", "index.js"]