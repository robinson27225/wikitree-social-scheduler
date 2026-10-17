FROM node:24-slim

# ffmpeg makes video preview pictures; tini keeps the process tidy and passes shutdown signals along.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates gosu \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    SOCIAL_SCHEDULER_DATA=/data \
    NO_OPEN=1 \
    TINI_SUBREAPER=1

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "src/server.ts"]
