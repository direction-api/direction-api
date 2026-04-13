require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');
const { fork, spawn } = require('child_process');
const path = require('path');
const redis = require('redis');
const amqplib = require('amqplib');

const app = express();
const PORT = process.env.PORT || 3000;
const RABBITMQ_URI = process.env.RABBITMQ_URI || 'amqp://localhost';
const GLOBAL_API_KEY = (process.env.GLOBAL_API_KEY || '').trim();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const runningInstances = new Map();

const pool = new Pool({
    connectionString: process.env.POSTGRES_URI || 'postgres://postgres:postgres@localhost:5432/direction_db',
    max: 20
});

async function connectWithRetry(retries = 10, delay = 3000) {
    for (let i = 1; i <= retries; i++) {
        try {
            await pool.query('SELECT 1');
            console.log('✅ PostgreSQL conectado');
            return;
        } catch (err) {
            console.error(`⏳ Postgres não disponível ainda (tentativa ${i}/${retries}): ${err.message}`);
            if (i === retries) {
                console.error('❌ Falha definitiva ao conectar no Postgres.');
                process.exit(1);
            }
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

async function ensureTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS instances (
            id          SERIAL PRIMARY KEY,
            token       UUID NOT NULL UNIQUE,
            name        VARCHAR(100) NOT NULL,
            ig_username VARCHAR(100) NOT NULL,
            ig_password TEXT NOT NULL,
            status      VARCHAR(30) DEFAULT 'Desconectado',
            webhook_url TEXT,
            created_at  TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS contacts (
            id              SERIAL PRIMARY KEY,
            instance_id     UUID NOT NULL,
            username        VARCHAR(100) NOT NULL UNIQUE,
            thread_id       TEXT,
            last_message_at TIMESTAMPTZ DEFAULT NOW(),
            created_at      TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS messages (
            id          SERIAL PRIMARY KEY,
            contact_id  INT REFERENCES contacts(id) ON DELETE CASCADE,
            instance_id UUID NOT NULL,
            text        TEXT,
            external_id TEXT UNIQUE,
            received_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_messages_instance ON messages(instance_id);
        CREATE INDEX IF NOT EXISTS idx_messages_contact  ON messages(contact_id);
        CREATE INDEX IF NOT EXISTS idx_contacts_instance ON contacts(instance_id);
    `);
    console.log('✅ Tabelas verificadas/criadas com sucesso');
}

const redisClient = redis.createClient({ url: process.env.REDIS_URI || 'redis://localhost:6379' });

app.post('/api/auth', (req, res) => {
    const incoming = (req.body.apiKey || '').trim();
    if (!GLOBAL_API_KEY) return res.status(500).json({ success: false, error: 'GLOBAL_API_KEY não configurada.' });
    if (incoming === GLOBAL_API_KEY) return res.json({ success: true });
    return res.status(401).json({ success: false, error: 'Chave inválida.' });
});

app.get('/api/instances', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, token, name, status, ig_username, created_at FROM instances ORDER BY id ASC');
        const instances = result.rows.map(inst => ({
            ...inst,
            status: runningInstances.has(inst.token) ? 'Conectado' : 'Desconectado'
        }));
        res.json({ success: true, instances });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/instances', async (req, res) => {
    const { name, ig_username, ig_password } = req.body;
    if (!name || !ig_username || !ig_password) return res.status(400).json({ success: false, error: 'Dados obrigatórios faltando.' });
    try {
        const token = uuidv4();
        const encodedPass = Buffer.from(ig_password).toString('base64');
        const result = await pool.query(
            'INSERT INTO instances (name, token, ig_username, ig_password) VALUES ($1, $2, $3, $4) RETURNING id, token, name, ig_username, status',
            [name, token, ig_username, encodedPass]
        );
        res.json({ success: true, instance: result.rows[0] });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/instances/:token', async (req, res) => {
    const { token } = req.params;
    const proc = runningInstances.get(token);
    if (proc) { proc.kill(); runningInstances.delete(token); }
    try {
        await pool.query('DELETE FROM instances WHERE token = $1', [token]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/instances/:token/connect', async (req, res) => {
    const { token } = req.params;
    if (runningInstances.has(token)) return res.json({ success: true, message: 'Já está em execução.' });
    try {
        const instResult = await pool.query('SELECT ig_username, ig_password FROM instances WHERE token = $1', [token]);
        if (!instResult.rows.length) return res.status(404).json({ success: false, error: 'Não encontrada.' });

        const { ig_username, ig_password } = instResult.rows[0];
        const decodedPass = Buffer.from(ig_password, 'base64').toString('utf-8');

        const scraperProcess = spawn('node', ['index.js'], {
            env: { ...process.env, INSTANCE_NAME: token, IG_USERNAME: ig_username, IG_PASSWORD: decodedPass },
            stdio: 'inherit',
            cwd: __dirname
        });

        scraperProcess.on('exit', () => {
            runningInstances.delete(token);
            pool.query("UPDATE instances SET status = 'Desconectado' WHERE token = $1", [token]).catch(() => { });
        });

        runningInstances.set(token, scraperProcess);
        await pool.query("UPDATE instances SET status = 'Conectado' WHERE token = $1", [token]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/instances/:token/disconnect', async (req, res) => {
    const { token } = req.params;
    const proc = runningInstances.get(token);
    if (proc) { proc.kill(); runningInstances.delete(token); }
    try {
        await pool.query("UPDATE instances SET status = 'Desconectado' WHERE token = $1", [token]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/send/:token', async (req, res) => {
    const { token } = req.params;

    const body = req.body || {};
    const { threadId, text } = body;

    if (!threadId || !text) {
        console.error(`[API SEND ERROR] Requisição inválida do n8n. Body recebido:`, req.body);
        return res.status(400).json({
            success: false,
            error: 'threadId e text são obrigatórios. Verifique se o n8n está enviando JSON válido com Content-Type: application/json.'
        });
    }

    try {
        const conn = await amqplib.connect(RABBITMQ_URI);
        const channel = await conn.createChannel();

        const targetQueue = `enviar_mensagem_${token}`;
        await channel.assertQueue(targetQueue, { durable: true });

        const payload = { instance_id: token, threadId, text, timestamp: new Date().toISOString() };
        channel.sendToQueue(targetQueue, Buffer.from(JSON.stringify(payload)), { persistent: true, contentType: 'application/json' });

        setTimeout(() => conn.close(), 500);
        res.json({ success: true, message: `Ordem enfileirada para ${token}` });
    } catch (err) {
        console.error(`[API SEND ERROR]`, err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/health', (req, res) => { res.json({ status: 'ok', uptime: process.uptime() }); });

async function autoRestart() {
    try {
        const result = await pool.query("SELECT token, ig_username, ig_password FROM instances WHERE status = 'Conectado'");
        for (const inst of result.rows) {
            const decodedPass = Buffer.from(inst.ig_password, 'base64').toString('utf-8');
            const scraper = spawn('node', ['index.js'], {
                env: { ...process.env, INSTANCE_NAME: inst.token, IG_USERNAME: inst.ig_username, IG_PASSWORD: decodedPass },
                stdio: 'inherit',
                cwd: __dirname
            });
            scraper.on('exit', () => runningInstances.delete(inst.token));
            runningInstances.set(inst.token, scraper);
            console.log(`Auto-reconectando instância: ${inst.token}`);
        }
    } catch (err) { console.error('autoRestart error:', err.message); }
}

async function startup() {
    await connectWithRetry();
    await ensureTables();
    await redisClient.connect().catch(err => { console.error('❌ Erro Redis:', err.message); process.exit(1); });
    fork('consumer.js');
    app.listen(PORT, () => {
        console.log(`Direction API rodando em http://0.0.0.0:${PORT}`);
        setTimeout(autoRestart, 3000);
    });
}

startup();