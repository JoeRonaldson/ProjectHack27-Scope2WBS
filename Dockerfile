FROM node:20-slim AS build

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

FROM node:20-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json ./
RUN npm install --omit=dev

COPY --from=build /app/dist-client ./dist-client
COPY --from=build /app/dist-server ./dist-server

EXPOSE 3000

CMD ["npm", "run", "start"]
