FROM node:22-alpine AS build
WORKDIR /app

COPY package.json ./
COPY services/api/package.json services/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install --ignore-scripts

COPY services/api services/api
COPY packages/shared packages/shared
RUN npm run build --workspace=@swiftdrop/api

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV API_PORT=4000

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/services/api/dist ./services/api/dist
COPY --from=build /app/services/api/package.json ./services/api/package.json
COPY --from=build /app/services/api/src/database/migrations ./services/api/src/database/migrations

RUN mkdir -p /var/lib/swiftdrop/uploads
EXPOSE 4000

CMD ["node", "services/api/dist/server.js"]
