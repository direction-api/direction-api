const amqplib = require('amqplib');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.POSTGRES_URI, max: 20 });
const logger = (lvl, mod, msg) => console.log(`[${new Date().toISOString()}] [${lvl}] [${mod}] ${msg}`);

async function connectRabbit(retries = 10) {
    for (let i = 0; i < retries; i++) {
        try {
            const conn = await amqplib.connect(process.env.RABBITMQ_URI);
            return await conn.createChannel();
        } catch (e) {
            logger('WARN', 'RABBIT', `Tentativa ${i + 1} falhou. Aguardando...`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    throw new Error('Não foi possível conectar ao RabbitMQ');
}

(async () => {
    const channel = await connectRabbit();
    await channel.assertQueue('mensagens', { durable: true });

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
                ON CONFLICT (username) DO UPDATE SET thread_id = EXCLUDED.thread_id, last_message_at = NOW()
                RETURNING id`, [metadata.instanceId, sender.username, sender.threadId]);

            await client.query(`
                INSERT INTO messages (contact_id, instance_id, text, external_id)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (external_id) DO NOTHING`, [res.rows[0].id, metadata.instanceId, message.text, message.id]);

            await client.query('COMMIT');

            // DISPARO DO WEBHOOK (Opcional)
            if (process.env.WEBHOOK_URL) {
                fetch(process.env.WEBHOOK_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).catch(() => { });
            }

            channel.ack(msg);
        } catch (e) {
            await client.query('ROLLBACK').catch(() => { });
            channel.nack(msg, false, true);
        } finally { client.release(); }
    });
})();