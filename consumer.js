const amqplib = require('amqplib');
const { Client } = require('pg');
require('dotenv').config();

const POSTGRES_URI = process.env.POSTGRES_URI || 'postgres://postgres:postgres@localhost:5432/direction_db';
const RABBITMQ_URI = process.env.RABBITMQ_URI || 'amqp://localhost';
const WEBHOOK_URL  = process.env.WEBHOOK_URL  || '';

function logger(level, mod, message) {
    console.log(`[${new Date().toISOString()}] [${level}] [${mod}] ${message}`);
}

// ----------------------------------------------------------------
// Envia o payload para o webhook configurado pelo usuário
// ----------------------------------------------------------------
async function forwardToWebhook(payload) {
    if (!WEBHOOK_URL) {
        logger('WARN', 'WEBHOOK', 'WEBHOOK_URL não configurada — mensagem não encaminhada.');
        return;
    }

    try {
        const res = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10000)
        });

        if (!res.ok) {
            logger('WARN', 'WEBHOOK', `Webhook retornou HTTP ${res.status}`);
        } else {
            logger('INFO', 'WEBHOOK', `✅ Encaminhado → ${WEBHOOK_URL}`);
        }
    } catch (err) {
        logger('ERROR', 'WEBHOOK', `Falha ao chamar webhook: ${err.message}`);
    }
}

// ----------------------------------------------------------------
// Conecta ao Postgres com retry
// ----------------------------------------------------------------
async function connectPostgres(retries = 15, delay = 3000) {
    const pgClient = new Client({ connectionString: POSTGRES_URI });
    for (let i = 1; i <= retries; i++) {
        try {
            await pgClient.connect();
            logger('INFO', 'DATABASE', 'PostgreSQL conectado');
            return pgClient;
        } catch (err) {
            logger('WARN', 'DATABASE', `Tentativa ${i}/${retries}: ${err.message}`);
            if (i === retries) { logger('FATAL', 'DATABASE', 'Não foi possível conectar ao Postgres.'); process.exit(1); }
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// ----------------------------------------------------------------
// Conecta ao RabbitMQ com retry
// ----------------------------------------------------------------
async function connectRabbitMQ(retries = 15, delay = 3000) {
    for (let i = 1; i <= retries; i++) {
        try {
            const conn    = await amqplib.connect(RABBITMQ_URI);
            const channel = await conn.createChannel();
            await channel.assertQueue('mensagens', { durable: true });
            await channel.prefetch(1);
            logger('INFO', 'RABBITMQ', 'Conectado — aguardando mensagens na fila "mensagens"...');
            return channel;
        } catch (err) {
            logger('WARN', 'RABBITMQ', `Tentativa ${i}/${retries}: ${err.message}`);
            if (i === retries) { logger('FATAL', 'RABBITMQ', 'Não foi possível conectar ao RabbitMQ.'); process.exit(1); }
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// ----------------------------------------------------------------
// Main
// ----------------------------------------------------------------
(async () => {
    const pgClient = await connectPostgres();
    const channel  = await connectRabbitMQ();

    channel.consume('mensagens', async (msg) => {
        if (!msg) return;

        try {
            const payload = JSON.parse(msg.content.toString());
            const { metadata, sender, message } = payload;

            logger('INFO', 'WORKER', `Processando: @${sender.username} → "${String(message.text).substring(0, 40)}"`);

            // 1. Persiste no PostgreSQL
            await pgClient.query('BEGIN');

            const contact = await pgClient.query(`
                INSERT INTO contacts (instance_id, username, thread_id)
                VALUES ($1, $2, $3)
                ON CONFLICT (username) DO UPDATE
                    SET last_message_at = NOW(), thread_id = EXCLUDED.thread_id
                RETURNING id;
            `, [metadata.instanceId, sender.username, sender.threadId]);

            await pgClient.query(`
                INSERT INTO messages (contact_id, instance_id, text, received_at, external_id)
                VALUES ($1, $2, $3, NOW(), $4)
                ON CONFLICT (external_id) DO NOTHING;
            `, [contact.rows[0].id, metadata.instanceId, message.text, message.id]);

            await pgClient.query('COMMIT');
            logger('INFO', 'POSTGRES', `MsgID ${message.id} salva`);

            // 2. Encaminha para o webhook do usuário
            await forwardToWebhook(payload);

            channel.ack(msg);
        } catch (err) {
            await pgClient.query('ROLLBACK').catch(() => {});
            logger('ERROR', 'WORKER', `Falha ao processar: ${err.message}`);
            channel.nack(msg, false, true);
        }
    });
})();