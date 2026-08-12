FROM node:20-slim AS build
WORKDIR /app
COPY package.json ./
COPY web/package.json web/
RUN npm install --omit=dev && npm --prefix web install
COPY . .
RUN npm --prefix web run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/ingest ./ingest
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/package.json ./
EXPOSE 8080
CMD ["node", "server/bridge.js"]
