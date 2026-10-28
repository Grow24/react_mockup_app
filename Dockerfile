FROM node:22.21.0-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22.21.0-slim
LABEL "language"="nodejs"
WORKDIR /src
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=build /src/dist ./dist
COPY --from=build /src/server-dist/server ./server
COPY --from=build /src/server-dist/shared ./shared
EXPOSE 8080
CMD ["node", "server/index.js"]
