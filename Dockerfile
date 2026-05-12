FROM node:18-slim

WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias
RUN npm install --only=production

# Copiar código
COPY . .

# Exponer puerto
EXPOSE 8080

# Comando para ejecutar
CMD ["node", "index.js"]
