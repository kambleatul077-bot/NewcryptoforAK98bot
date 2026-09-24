FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY index.js ./index.js
COPY .env.example ./
CMD ["npm", "start"]
