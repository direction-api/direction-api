const amqplib = require('amqplib');
const { Pool } = require('pg');
require('dotenv').config();

const POSTGRES_URI = process.env.POSTGRES_URI;
const RABBITMQ_URI = process.env.RABBITMQ_URI;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const pool = new Pool({
    connectionString: POSTGRES_URI,
    max: 15,
    idleTimeoutMillis: 30000
});

const logger = (lvl, mod, msg) => console.log(`[${new Date().toISOString()}] [${lvl}] [${mod}] ${msg}`);

async function forwardToWebhook(payload) {
    if (!WEBHOOK_URL) return;
    try {
        const res = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) logger('WARN', 'WEBHOOK', `HTTP ${res.status}`);
    } catch (err) { logger('ERROR', 'WEBHOOK', err.message); }
}

async function start() {
    try {
        const conn = await amqplib.connect(RABBITMQ_URI);
        const channel = await conn.createChannel();
        await channel.assertQueue('mensagens', { durable: true });
        await channel.prefetch(1);

        logger('INFO', 'WORKER', 'Aguardando mensagens da fila...');

        channel.consume('mensagens', async (msg) => {
            if (!msg) return;
            const client = await pool.connect();
            try {
                const payload = JSON.parse(msg.content.toString());
                const { metadata, sender, message } = payload;

                await client.query('BEGIN');
                const res = await client.query(`
                    INSERT INTO contacts (instance_id, username, thread_id)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (username) DO UPDATE SET last_message_at = NOW(), thread_id = EXCLUDED.thread_id
                    RETURNING id`, [metadata.instanceId, sender.username, sender.threadId]);

                await client.query(`
                    INSERT INTO messages (contact_id, instance_id, text, external_id)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (external_id) DO NOTHING`, [res.rows[0].id, metadata.instanceId, message.text, message.id]);

                await client.query('COMMIT');
                await forwardToWebhook(payload);
                channel.ack(msg);
            } catch (e) {
                await client.query('ROLLBACK').catch(() => { });
                logger('ERROR', 'DB', e.message);
                channel.nack(msg, false, true);
            } finally {
                client.release();
            }
        });
    } catch (e) { logger('FATAL', 'WORKER', e.message); process.exit(1); }
}

start();