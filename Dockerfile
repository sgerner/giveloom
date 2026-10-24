FROM node:22.21.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22.21.1-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/migrations ./migrations
RUN mkdir -p /data/uploads /data/exports /backups && chown -R node:node /data /backups
USER node
EXPOSE 3000
CMD ["node", "build"]
