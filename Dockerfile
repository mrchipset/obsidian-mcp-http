# Build the TypeScript sources once, then ship only production dependencies.
FROM node:22.23.4-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22.23.4-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOME=/home/node
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

USER node
EXPOSE 8787
ENTRYPOINT ["node", "dist/main.js"]
CMD ["serve"]
