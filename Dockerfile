FROM node:20-slim AS build
WORKDIR /app
COPY . .
RUN npm install \
 && npm --prefix web install \
 && npm --prefix web run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app .
EXPOSE 8080
CMD ["node", "server/bridge.js"]
