FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY index.js ./index.js
COPY .env.example ./.env.example

CMD ["npm", "start"]
