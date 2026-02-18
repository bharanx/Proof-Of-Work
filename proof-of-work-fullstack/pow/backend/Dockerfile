FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Create data directory for SQLite
RUN mkdir -p /app/data

ENV PORT=3001
ENV NODE_ENV=production

EXPOSE 3001

CMD ["node", "server.js"]
