FROM node:20-slim

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY dist ./dist
COPY src/config/approvalMatrix.json ./dist/config/approvalMatrix.json

CMD ["node", "dist/index.js"]
