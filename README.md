<div align="center">

# 🚀 Direction API

**Self-hosted Instagram Direct Messaging API**

Gerencie múltiplas contas do Instagram com mensagens em tempo real, filas via RabbitMQ e persistência em PostgreSQL.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker)](docker-compose.yml)
[![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js)](Dockerfile)

</div>

---

## ✨ O que é a Direction API?

A Direction API é uma plataforma **open-source e self-hosted** que permite gerenciar múltiplas contas do Instagram programaticamente. Ela é pensada para **agências**, **desenvolvedores** e **negócios** que precisam de:

- 📩 **Receber mensagens** do Instagram Direct em tempo real via RabbitMQ
- 📤 **Enviar mensagens** via API REST
- 🔗 **Integrar** com n8n, Make, Zapier ou qualquer webhook
- 🛡️ **Multi-instância** com isolamento total entre contas
- 📊 **Dashboard web** para gerenciar conexões

---

## 🏗️ Arquitetura

```
[Instagram] ──scraper──▶ [RabbitMQ: mensagens] ──▶ [consumer.js] ──▶ [PostgreSQL]
                                                  └──▶ [Seu Webhook/n8n]

[Seu n8n/Make] ──POST /api/send/:token──▶ [RabbitMQ: enviar_mensagem] ──▶ [scraper] ──▶ [Instagram]
```

**Serviços:**
| Serviço | Porta | Descrição |
|---|---|---|
| Direction API | `3000` | API REST + Dashboard web |
| RabbitMQ | `5672` / `15672` | Fila de mensagens |
| PostgreSQL | `5432` | Banco de dados |
| Redis | `6379` | Cache de sessões do Instagram |

---

## ⚡ Início Rápido (5 passos)

### Pré-requisitos
- **Docker** e **Docker Compose** instalados
- Uma VPS ou servidor com acesso à internet

### 1. Clone o repositório
```bash
git clone https://github.com/directionapi/direction-api.git
cd direction-api
```

### 2. Configure as variáveis (Opcional)
Se desejar personalizar as senhas, edite o arquivo `docker-compose.yml` ou crie um `.env`. 
As senhas padrão de fábrica são: `admin`.

Edite o `.env` e defina:
```env
GLOBAL_API_KEY=MINHA_CHAVE_ULTRA_SECRETA   # Chave para acessar o painel
POSTGRES_PASSWORD=SENHA_FORTE_DO_BANCO
RABBITMQ_PASSWORD=SENHA_FORTE_DO_RABBITMQ
WEBHOOK_URL=https://meu-n8n.com/webhook/instagram
```

> ⚠️ **Substitua todas as senhas** antes de colocar em produção!

### 3. Suba os containers
```bash
docker compose up -d
```

### 4. Acesse o painel
Abra `http://SEU_IP_OU_DOMINIO:3000` no navegador.

- A URL do servidor já será preenchida automaticamente
- Digite sua `GLOBAL_API_KEY` definida no `.env`

### 5. Crie uma instância
No dashboard, clique em **Nova Instância**, preencha as credenciais do Instagram e clique em **Conectar**.

---

## 🔐 Variáveis de Ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `GLOBAL_API_KEY` | ✅ | Chave secreta para acessar o painel web |
| `POSTGRES_URI` | ✅ | URI de conexão do PostgreSQL |
| `RABBITMQ_URI` | ✅ | URI de conexão do RabbitMQ |
| `REDIS_URI` | ✅ | URI de conexão do Redis |
| `WEBHOOK_URL` | ✅ | URL que receberá as mensagens capturadas |
| `POSTGRES_USER` | ⚙️ | Usuário do PostgreSQL (padrão: `postgres`) |
| `POSTGRES_PASSWORD` | ✅ | Senha do PostgreSQL |
| `POSTGRES_DB` | ⚙️ | Nome do banco (padrão: `direction_db`) |
| `RABBITMQ_USER` | ⚙️ | Usuário do RabbitMQ (padrão: `admin`) |
| `RABBITMQ_PASSWORD` | ✅ | Senha do RabbitMQ |

---

## 🌐 Usando com Domínio + HTTPS (Recomendado)

Para produção real, use um proxy reverso como **Nginx** ou **Caddy** com SSL:

### Nginx (exemplo)
```nginx
server {
    listen 80;
    server_name directionapi.seudominio.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name directionapi.seudominio.com;

    ssl_certificate     /etc/ssl/certs/seu_cert.pem;
    ssl_certificate_key /etc/ssl/private/sua_chave.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Caddy (mais simples, HTTPS automático)
```caddyfile
directionapi.seudominio.com {
    reverse_proxy localhost:3000
}
```

---

## 📚 Documentação da API

- [**Referência das Rotas REST**](docs/API.md)
- [**Como receber mensagens (Webhooks)**](docs/WEBHOOK.md)

---

## 🤝 Contribuindo

Pull requests são bem-vindos! Sinta-se livre para abrir issues, sugerir funcionalidades ou enviar melhorias.

---

## 📄 Licença

Distribuído sob a licença **MIT**. Consulte o arquivo [LICENSE](LICENSE) para mais detalhes.
