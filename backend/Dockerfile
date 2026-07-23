# Image minimale — aucune dépendance npm à télécharger (voir README_BACKEND.md).
FROM node:22-slim

WORKDIR /app
COPY . .

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

VOLUME ["/app/data"]

CMD ["node", "server.js"]
