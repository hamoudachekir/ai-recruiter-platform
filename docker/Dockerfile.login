FROM node:20-bookworm-slim AS build

WORKDIR /app

ARG VITE_API_BASE_URL=http://localhost:3001
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

COPY Frontend/login/package.json Frontend/login/package-lock.json* ./
RUN npm ci

COPY Frontend/login/ ./
RUN npm run build

FROM nginx:1.27-alpine

COPY docker/nginx/login.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
