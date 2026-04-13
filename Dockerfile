# ============================================================
# Direction API — Dockerfile
# Imagem de produção com Node.js 20 + Playwright Chromium
# ============================================================

FROM node:20-slim

# Dependências do sistema para o Playwright / Chromium
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia manifesto e instala dependências
COPY package*.json ./
RUN npm ci --omit=dev

# Instala o Chromium do Playwright
RUN npx playwright install chromium

# Copia o código da aplicação
COPY . .

# Porta da API
EXPOSE 3000

# Inicia o servidor principal
CMD ["node", "server.js"]
