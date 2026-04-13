const amqplib = require('amqplib');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.POSTGRES_URI || 'postgres://postgres:postgres@localhost:5432/direction_db',
    max: 20
});

const RABBITMQ_URI = process.env.RABBITMQ_URI || 'amqp://localhost';
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const logger = (lvl, mod, msg) => console.log(`[${new Date().toISOString()}] [${lvl}] [${mod}] ${msg}`);

async function connectRabbit(retries = 15) {
    for (let i = 0; i < retries; i++) {
        try {
            const conn = await amqplib.connect(RABBITMQ_URI);
            const channel = await conn.createChannel();
            await channel.assertQueue('mensagens', { durable: true });
            await channel.prefetch(1);
            return channel;
        } catch (e) {
            logger('WARN', 'RABBIT', `Tentativa de conexão falhou (${i + 1}/${retries}). Aguardando...`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    throw new Error('Falha crítica: RabbitMQ não está acessível após várias tentativas.');
}

async function forwardToWebhook(payload) {
    if (!WEBHOOK_URL) return;
    try {
        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            logger('WARN', 'WEBHOOK', `Erro HTTP ao enviar webhook: ${response.status}`);
        } else {
            logger('INFO', 'WEBHOOK', '✅ Webhook disparado com sucesso');
        }
    } catch (err) {
        logger('ERROR', 'WEBHOOK', `Falha de rede ao disparar webhook: ${err.message}`);
    }
}

async function start() {
    try {
        const channel = await connectRabbit();
        logger('INFO', 'WORKER', '🚀 Consumer online. Aguardando mensagens na fila...');

        channel.consume('mensagens', async (msg) => {
            if (!msg) return;
            const client = await pool.connect();
            try {
                const payload = JSON.parse(msg.content.toString());
                const { metadata, sender, message } = payload;

                await client.query('BEGIN');

                // Grava ou atualiza contato
                const contactResult = await client.query(`
                    INSERT INTO contacts (instance_id, username, thread_id)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (username) DO UPDATE 
                    SET thread_id = EXCLUDED.thread_id, last_message_at = NOW()
                    RETURNING id
                `, [metadata.instanceId, sender.username, sender.threadId]);

                // Grava a mensagem
                await client.query(`
                    INSERT INTO messages (contact_id, instance_id, text, external_id)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (external_id) DO NOTHING
                `, [contactResult.rows[0].id, metadata.instanceId, message.text, message.id]);

                await client.query('COMMIT');

                await forwardToWebhook(payload);

                channel.ack(msg);
                logger('INFO', 'WORKER', `Processada e salva: Mensagem de ${sender.username}`);
            } catch (e) {
                await client.query('ROLLBACK').catch(() => { });
                logger('ERROR', 'DB', `Falha ao processar mensagem: ${e.message}`);
                channel.nack(msg, false, true); // Reenfileira em caso de falha de banco
            } finally {
                client.release();
            }
        });
    } catch (err) {
        logger('FATAL', 'WORKER', err.message);
        process.exit(1);
    }
}

start();