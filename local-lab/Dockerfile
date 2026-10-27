FROM node:22-alpine AS build
WORKDIR /lab
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run check && npm run build && npm prune --omit=dev
FROM node:22-alpine
WORKDIR /lab
COPY --from=build /lab/node_modules ./node_modules
COPY --from=build /lab/dist ./dist
COPY package.json ./
USER node
CMD ["node", "dist/app.js"]
