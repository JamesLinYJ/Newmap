FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared-types ./packages/shared-types
RUN npm ci

COPY apps/web ./apps/web

ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

RUN npm run build --workspace apps/web

FROM nginx:1.27-alpine

COPY infra/docker/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
