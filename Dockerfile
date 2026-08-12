FROM node:22-trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .
RUN chown node:node /app

ENV NODE_ENV=production
USER node
EXPOSE 3100
CMD ["npm", "start"]
