FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY scanner.js ./
CMD ["node", "scanner.js"]
