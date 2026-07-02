FROM node:20-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY server/ ./server/
COPY public/ ./public/
EXPOSE 3000
CMD ["node", "server/index.js"]
