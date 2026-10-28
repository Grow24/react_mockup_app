FROM node:22-slim AS build
LABEL "language"="nodejs"
LABEL "framework"="vite"
WORKDIR /src
COPY . .
RUN npm install
RUN npm run build

FROM zeabur/caddy-static
COPY --from=build /src/dist /usr/share/caddy
