# Direction API — Referência da API REST

Base URL: `http://SEU_SERVIDOR:3000`

> Todas as rotas retornam JSON.

---

## 🔑 Autenticação do Painel

### `POST /api/auth`

Valida a chave de acesso ao painel. Chamado pela página de login.

**Body:**
```json
{
  "apiKey": "SUA_GLOBAL_API_KEY"
}
```

**Resposta — Sucesso (`200`):**
```json
{ "success": true }
```

**Resposta — Falha (`401`):**
```json
{ "success": false, "error": "Chave inválida." }
```

---

## 📋 Instâncias

### `GET /api/instances`

Lista todas as instâncias cadastradas e seus status.

**Resposta:**
```json
{
  "success": true,
  "instances": [
    {
      "id": 1,
      "token": "uuid-da-instancia",
      "name": "Conta Principal",
      "ig_username": "minha_conta_ig",
      "status": "Conectado",
      "created_at": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

---

### `POST /api/instances`

Cria uma nova instância de conta do Instagram.

**Body:**
```json
{
  "name": "Nome da Instância",
  "ig_username": "username_do_instagram",
  "ig_password": "senha_do_instagram"
}
```

**Resposta — Sucesso (`200`):**
```json
{
  "success": true,
  "instance": {
    "id": 1,
    "token": "uuid-gerado-automaticamente",
    "name": "Nome da Instância",
    "ig_username": "username_do_instagram",
    "status": "Desconectado"
  }
}
```

> ⚠️ A senha é armazenada em Base64. Não use isso como criptografia real — proteja o acesso ao banco de dados.

---

### `DELETE /api/instances/:token`

Remove uma instância e desconecta o scraper se estiver ativo.

**Parâmetros:**
- `:token` — UUID da instância

**Resposta:**
```json
{ "success": true }
```

---

### `POST /api/instances/:token/connect`

Inicia o scraper do Instagram para a instância especificada.

**Parâmetros:**
- `:token` — UUID da instância

**Resposta — Sucesso:**
```json
{ "success": true }
```

**Resposta — Já conectada:**
```json
{ "success": true, "message": "Instância já está em execução." }
```

---

### `POST /api/instances/:token/disconnect`

Para o scraper da instância.

**Parâmetros:**
- `:token` — UUID da instância

**Resposta:**
```json
{ "success": true }
```

---

## 📤 Envio de Mensagens

### `POST /api/send/:token`

Enfileira uma mensagem para envio via Instagram Direct.

**Parâmetros:**
- `:token` — UUID da instância que vai enviar a mensagem

**Body:**
```json
{
  "threadId": "ID_DA_CONVERSA_NO_INSTAGRAM",
  "text": "Olá! Como posso te ajudar?"
}
```

> 💡 O `threadId` é o identificador da thread do Instagram Direct. Você o recebe no payload de mensagens recebidas (campo `sender.threadId`).

**Resposta — Sucesso:**
```json
{
  "success": true,
  "message": "Mensagem enfileirada com sucesso."
}
```

**Resposta — Parâmetros faltando (`400`):**
```json
{
  "success": false,
  "error": "threadId e text são obrigatórios."
}
```

---

## ❤️ Health Check

### `GET /api/health`

Verifica se o servidor está online. Útil para monitoramento e proxies reversos.

**Resposta:**
```json
{
  "status": "ok",
  "uptime": 3621.45
}
```

---

## 📊 Tabela Resumo

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/api/auth` | Autenticação no painel |
| `GET` | `/api/instances` | Listar instâncias |
| `POST` | `/api/instances` | Criar instância |
| `DELETE` | `/api/instances/:token` | Remover instância |
| `POST` | `/api/instances/:token/connect` | Conectar instância |
| `POST` | `/api/instances/:token/disconnect` | Desconectar instância |
| `POST` | `/api/send/:token` | Enviar mensagem |
| `GET` | `/api/health` | Health check |
