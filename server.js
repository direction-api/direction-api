require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { Client } = require('pg');
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

// --- POSTGRES ---
let pgClient = null;

async function connectWithRetry(retries = 10, delay = 3000) {
    for (let i = 1; i <= retries; i++) {
        try {
            // Se já houver um cliente, tenta fechar antes de criar um novo (garantia)
            if (pgClient) { try { await pgClient.end(); } catch (e) { } }
            
            pgClient = new Client({
                connectionString: process.env.POSTGRES_URI || 'postgres://postgres:postgres@localhost:5432/direction_db'
            });

            await pgClient.connect();
            console.log('✅ PostgreSQL conectado');
            return;
        } catch (err) {
            console.error(`⏳ Postgres não disponível ainda (tentativa ${i}/${retries}): ${err.message}`);
            if (i === retries) { console.error('❌ Falha definitiva ao conectar no Postgres.'); process.exit(1); }
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// Cria as tabelas automaticamente se não existirem (auto-migrate)
async function ensureTables() {
    await pgClient.query(`
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

// --- REDIS ---
const redisClient = redis.createClient({ url: process.env.REDIS_URI || 'redis://localhost:6379' });
// Conectado no startup() abaixo de forma controlada



// ============================================================
// ROTA: POST /api/auth — Autenticação pelo painel
// Body: { apiKey: "..." }
// ============================================================
app.post('/api/auth', (req, res) => {
    const incoming = (req.body.apiKey || '').trim();

    if (!GLOBAL_API_KEY) {
        return res.status(500).json({ success: false, error: 'GLOBAL_API_KEY não configurada no servidor.' });
    }

    if (incoming === GLOBAL_API_KEY) {
        return res.json({ success: true });
    }

    return res.status(401).json({ success: false, error: 'Chave inválida.' });
});

// ============================================================
// ROTA: GET /api/instances — Lista todas as instâncias
// ============================================================
app.get('/api/instances', async (req, res) => {
    try {
        const result = await pgClient.query(
            'SELECT id, token, name, status, ig_username, created_at FROM instances ORDER BY id ASC'
        );
        const instances = result.rows.map(inst => ({
            ...inst,
            status: runningInstances.has(inst.token) ? 'Conectado' : 'Desconectado'
        }));
        res.json({ success: true, instances });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// ROTA: POST /api/instances — Cria nova instância
// Body: { name, ig_username, ig_password }
// ============================================================
app.post('/api/instances', async (req, res) => {
    const { name, ig_username, ig_password } = req.body;

    if (!name || !ig_username || !ig_password) {
        return res.status(400).json({ success: false, error: 'name, ig_username e ig_password são obrigatórios.' });
    }

    try {
        const token = uuidv4();
        const encodedPass = Buffer.from(ig_password).toString('base64');
        const result = await pgClient.query(
            'INSERT INTO instances (name, token, ig_username, ig_password) VALUES ($1, $2, $3, $4) RETURNING id, token, name, ig_username, status',
            [name, token, ig_username, encodedPass]
        );
        res.json({ success: true, instance: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// ROTA: DELETE /api/instances/:token — Remove instância
// ============================================================
app.delete('/api/instances/:token', async (req, res) => {
    const { token } = req.params;
    const proc = runningInstances.get(token);
    if (proc) { proc.kill(); runningInstances.delete(token); }

    try {
        await pgClient.query('DELETE FROM instances WHERE token = $1', [token]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// ROTA: POST /api/instances/:token/connect — Conecta instância
// ============================================================
app.post('/api/instances/:token/connect', async (req, res) => {
    const { token } = req.params;

    if (runningInstances.has(token)) {
        return res.json({ success: true, message: 'Instância já está em execução.' });
    }

    try {
        const instResult = await pgClient.query(
            'SELECT ig_username, ig_password FROM instances WHERE token = $1',
            [token]
        );

        if (!instResult.rows.length) {
            return res.status(404).json({ success: false, error: 'Instância não encontrada.' });
        }

        const { ig_username, ig_password } = instResult.rows[0];
        const decodedPass = Buffer.from(ig_password, 'base64').toString('utf-8');

        const scraperProcess = spawn('node', ['index.js'], {
            env: {
                ...process.env,
                INSTANCE_NAME: token,
                IG_USERNAME: ig_username,
                IG_PASSWORD: decodedPass
            },
            stdio: 'inherit',
            cwd: __dirname
        });

        scraperProcess.on('exit', () => {
            runningInstances.delete(token);
            pgClient.query("UPDATE instances SET status = 'Desconectado' WHERE token = $1", [token]).catch(() => {});
        });

        runningInstances.set(token, scraperProcess);
        await pgClient.query("UPDATE instances SET status = 'Conectado' WHERE token = $1", [token]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// ROTA: POST /api/instances/:token/disconnect — Desconecta
// ============================================================
app.post('/api/instances/:token/disconnect', async (req, res) => {
    const { token } = req.params;
    const proc = runningInstances.get(token);

    if (proc) { proc.kill(); runningInstances.delete(token); }

    try {
        await pgClient.query("UPDATE instances SET status = 'Desconectado' WHERE token = $1", [token]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// ROTA: POST /api/send/:token — Envia mensagem via fila
// Body: { threadId, text }
// ============================================================
app.post('/api/send/:token', async (req, res) => {
    const { token } = req.params;
    const { threadId, text } = req.body;

    if (!threadId || !text) {
        return res.status(400).json({ success: false, error: 'threadId e text são obrigatórios.' });
    }

    try {
        const conn = await amqplib.connect(RABBITMQ_URI);
        const channel = await conn.createChannel();

        const payload = {
            instance_id: token,
            threadId,
            text,
            timestamp: new Date().toISOString()
        };

        channel.sendToQueue('enviar_mensagem', Buffer.from(JSON.stringify(payload)), {
            persistent: true,
            contentType: 'application/json'
        });

        setTimeout(() => conn.close(), 500);
        res.json({ success: true, message: 'Mensagem enfileirada com sucesso.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// ROTA: GET /api/health — Health check
// ============================================================
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// ============================================================
// Auto-reconexão de instâncias ao reiniciar
// ============================================================
async function autoRestart() {
    try {
        const result = await pgClient.query(
            "SELECT token, ig_username, ig_password FROM instances WHERE status = 'Conectado'"
        );
        for (const inst of result.rows) {
            const decodedPass = Buffer.from(inst.ig_password, 'base64').toString('utf-8');
            const scraper = spawn('node', ['index.js'], {
                env: { ...process.env, INSTANCE_NAME: inst.token, IG_USERNAME: inst.ig_username, IG_PASSWORD: decodedPass },
                stdio: 'inherit',
                cwd: __dirname
            });
            scraper.on('exit', () => runningInstances.delete(inst.token));
            runningInstances.set(inst.token, scraper);
            console.log(`♻️  Auto-reconectando instância: ${inst.token}`);
        }
    } catch (err) {
        console.error('❌ autoRestart error:', err.message);
    }
}

// ============================================================
// Startup — conecta serviços, migra banco e sobe HTTP
// ============================================================
async function startup() {
    // 1. Conecta ao Postgres com retry automático
    await connectWithRetry();

    // 2. Garante que as tabelas existem (auto-migrate)
    await ensureTables();

    // 3. Conecta ao Redis
    await redisClient.connect().catch(err => {
        console.error('❌ Erro Redis:', err.message);
        process.exit(1);
    });

    // 4. Sobe o consumer e o servidor HTTP
    fork('consumer.js');
    app.listen(PORT, () => {
        console.log(`🚀 Direction API rodando em http://0.0.0.0:${PORT}`);
        setTimeout(autoRestart, 3000);
    });
}

startup();