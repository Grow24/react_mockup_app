FROM node:22-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /src
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=build /src/dist ./dist
COPY --from=build /src/server ./server
COPY --from=build /src/shared ./shared
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "server/index.ts"]
