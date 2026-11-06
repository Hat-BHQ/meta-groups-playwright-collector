FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server-groups.js groups.config.js playwright-groups.config.js ./

RUN mkdir -p /app/data

EXPOSE 3001

CMD ["node", "server-groups.js"]
