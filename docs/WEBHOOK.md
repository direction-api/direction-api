# Direction API — Como Receber Mensagens (Webhooks)

A Direction API usa **RabbitMQ** como backbone de mensageria. Quando uma mensagem do Instagram Direct é capturada, ela é publicada na fila `mensagens` e processada pelo `consumer.js`, que a salva no PostgreSQL e envia para o seu **webhook de destino**.

---

## 🔁 Fluxo de uma Mensagem Recebida

```
Instagram Direct
      │
      ▼ (scraper Playwright detecta)
┌─────────────────────┐
│  Fila: "mensagens"  │  ← RabbitMQ
└─────────────────────┘
      │
      ▼ (consumer.js processa)
┌──────────────┐     ┌──────────────────────┐
│  PostgreSQL  │ +   │  Seu Webhook (n8n)   │
│  (histórico) │     │  (automação em tempo │
└──────────────┘     │   real)              │
                     └──────────────────────┘
```

---

## 📦 Payload da Mensagem Recebida

Quando uma nova mensagem chega, o `consumer.js` envia um `POST` para o seu `WEBHOOK_URL` com o seguinte corpo JSON:

```json
{
  "metadata": {
    "event": "MESSAGES_UPSERT",
    "instanceId": "uuid-da-instancia"
  },
  "sender": {
    "username": "usuario_do_instagram",
    "threadId": "ID_DA_THREAD_DO_DIRECT"
  },
  "message": {
    "id": "ID_UNICO_DA_MENSAGEM",
    "text": "Olá, quero saber mais sobre o produto!"
  }
}
```

### Campos

| Campo | Tipo | Descrição |
|---|---|---|
| `metadata.event` | `string` | Sempre `"MESSAGES_UPSERT"` |
| `metadata.instanceId` | `string` (UUID) | Qual conta recebeu a mensagem |
| `sender.username` | `string` | @ do usuário que enviou |
| `sender.threadId` | `string` | ID da thread (use para responder) |
| `message.id` | `string` | ID único da mensagem no Instagram |
| `message.text` | `string` | Conteúdo da mensagem |

---

## 🔗 Configurando no n8n

### Passo 1 — Crie um Webhook Node
1. No n8n, crie um novo workflow
2. Adicione um nó **Webhook**
3. Selecione método `POST`
4. Copie a URL gerada (ex: `https://meu-n8n.com/webhook/instagram`)

### Passo 2 — Configure no .env
No arquivo `.env` da Direction API:
```env
WEBHOOK_URL=https://meu-n8n.com/webhook/instagram
```

### Passo 3 — Acesse os dados no n8n
No n8n, os dados chegam em `$json.body`:
```json
// Ex: acessar o texto da mensagem
{{ $json.body.message.text }}

// Ex: acessar o threadId para responder
{{ $json.body.sender.threadId }}

// Ex: acessar o instanceId
{{ $json.body.metadata.instanceId }}
```

---

## 📤 Respondendo a uma Mensagem via n8n

Para enviar uma resposta, após processar a mensagem no n8n, adicione um nó **HTTP Request**:

- **Método:** `POST`
- **URL:** `http://SEU_SERVIDOR:3000/api/send/{{ $json.body.metadata.instanceId }}`
- **Body (JSON):**

```json
{
  "threadId": "{{ $json.body.sender.threadId }}",
  "text": "Olá! Sua mensagem foi recebida. Em breve retornarei."
}
```

---

## 🔌 Usando com Make (Integromat)

1. Crie um cenário com o módulo **Webhooks → Custom Webhook**
2. Copie a URL gerada e configure no `.env` como `WEBHOOK_URL`
3. Use o módulo **HTTP → Make a Request** para enviar respostas via `/api/send/:token`

---

## 🥇 Boas Práticas

- **Responda rápido**: O consumer aguarda resposta HTTP `2xx`. Retorne `200` imediatamente e processe em background.
- **Idempotência**: Cada mensagem tem um `message.id` único — use ele para evitar processamentos duplicados.
- **Segurança**: Coloque a Direction API atrás de um proxy reverso com HTTPS em produção.
- **Monitoramento**: Acesse o painel do RabbitMQ em `http://SEU_SERVIDOR:15672` (usuário/senha definidos no `.env`) para visualizar as filas.
