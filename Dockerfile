FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN node -e "require('./package.json')" && echo "package.json is valid" || { echo "Invalid package.json"; exit 1; }

RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
