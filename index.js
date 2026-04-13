const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const amqplib = require('amqplib');
const redis = require('redis');
const fs = require('fs');
const path = require('path');

let amqpChannel = null;
let redisClient = null;
let isPaused = false;

const IG_USER = process.env.IG_USERNAME;
const IG_PASS = process.env.IG_PASSWORD;
const INSTANCE_ID = process.env.INSTANCE_NAME; // Esse é o TOKEN da instância
const RABBITMQ_URI = process.env.RABBITMQ_URI || 'amqp://localhost';
const REDIS_URI = process.env.REDIS_URI || 'redis://localhost:6379';
const BROWSER_DATA_DIR = `/app/browser_data/session_${IG_USER}`;

const logger = (lvl, mod, msg) => console.log(`[${new Date().toISOString()}] [${lvl}] [${mod}] ${msg}`);

async function initializeServices() {
    try {
        const conn = await amqplib.connect(RABBITMQ_URI);
        amqpChannel = await conn.createChannel();
        await amqpChannel.assertQueue('mensagens', { durable: true });

        // Fila EXCLUSIVA para esta instância não dar conflito com outras
        const mySendQueue = `enviar_mensagem_${INSTANCE_ID}`;
        await amqpChannel.assertQueue(mySendQueue, { durable: true });

        redisClient = redis.createClient({ url: REDIS_URI });
        await redisClient.connect();
        logger('INFO', 'SERVICES', `Serviços OK. Escutando fila: ${mySendQueue}`);
    } catch (e) {
        logger('ERROR', 'SERVICES', `Falha inicialização: ${e.message}`);
        process.exit(1);
    }
}

async function performLogin(page) {
    logger('WARN', 'AUTH', 'Iniciando login bruto...');
    try {
        await page.waitForLoadState('networkidle');
        const inputs = page.locator('input');
        await inputs.first().waitFor({ state: 'attached', timeout: 20000 });
        await inputs.nth(0).fill(IG_USER);
        await inputs.nth(1).fill(IG_PASS);
        await page.keyboard.press('Enter');

        await page.waitForFunction(() => !document.URL.includes('accounts/login'), { timeout: 60000 });

        for (let i = 0; i < 3; i++) {
            if (page.url().includes('direct/inbox')) break;
            if (page.url().includes('onetap')) {
                const btn = page.locator('button:has-text("Agora não"), button:has-text("Not Now")').first();
                if (await btn.isVisible()) await btn.click();
            }
            await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded' }).catch(() => { });
            await page.waitForTimeout(3000);
        }
        await page.context().storageState({ path: `${BROWSER_DATA_DIR}/state.json` });
        logger('INFO', 'AUTH', 'Sessão salva!');
    } catch (err) { throw err; }
}

(async () => {
    if (!fs.existsSync(BROWSER_DATA_DIR)) fs.mkdirSync(BROWSER_DATA_DIR, { recursive: true });
    await initializeServices();

    while (true) {
        let browser = null;
        try {
            browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
            const storagePath = `${BROWSER_DATA_DIR}/state.json`;
            const context = await browser.newContext({
                storageState: fs.existsSync(storagePath) ? storagePath : undefined,
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
            });

            const page = await context.newPage();
            await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded' });

            if (page.url().includes('login') || page.url().includes('accounts')) await performLogin(page);

            // 📬 OUTBOUND: Escuta apenas a SUA própria fila
            amqpChannel.consume(`enviar_mensagem_${INSTANCE_ID}`, async (msg) => {
                if (!msg) return;
                isPaused = true;
                const { threadId, text } = JSON.parse(msg.content.toString());
                try {
                    await page.goto(`https://www.instagram.com/direct/t/${threadId}/`);
                    await page.locator('div[role="textbox"]').first().fill(text);
                    await page.keyboard.press('Enter');
                    amqpChannel.ack(msg);
                    logger('INFO', 'OUTBOUND', `Mensagem enviada para ${threadId}`);
                } catch (e) { amqpChannel.nack(msg, false, true); }
                finally { isPaused = false; await page.goto('https://www.instagram.com/direct/inbox/'); }
            });

            // 📨 INBOUND: Captura username real
            while (true) {
                if (!isPaused) {
                    const data = await page.evaluate(async () => {
                        const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1];
                        const res = await fetch('/api/v1/direct_v2/inbox/?folder=0', {
                            headers: { 'x-csrftoken': csrf || '', 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' }
                        });
                        return res.ok ? await res.json() : null;
                    });

                    if (data?.inbox?.threads) {
                        const myId = await page.evaluate(() => document.cookie.match(/ds_user_id=([^;]+)/)?.[1]);
                        for (const thread of data.inbox.threads) {
                            for (const item of thread.items) {
                                if (item.item_type === 'text' && String(item.user_id) !== String(myId)) {
                                    const seen = await redisClient.get(`seen:${INSTANCE_ID}:${item.item_id}`);
                                    if (!seen) {
                                        // AQUI ESTÁ A CORREÇÃO DO USERNAME:
                                        const senderObj = thread.users.find(u => String(u.pk) === String(item.user_id));
                                        const realUsername = senderObj ? senderObj.username : 'desconhecido';

                                        const payload = {
                                            metadata: { instanceId: INSTANCE_ID },
                                            sender: { username: realUsername, threadId: thread.thread_id },
                                            message: { id: item.item_id, text: item.text }
                                        };
                                        amqpChannel.sendToQueue('mensagens', Buffer.from(JSON.stringify(payload)), { persistent: true });
                                        await redisClient.set(`seen:${INSTANCE_ID}:${item.item_id}`, '1', { EX: 86400 });
                                        logger('INFO', 'INBOUND', `Mensagem de @${realUsername}`);
                                    }
                                }
                            }
                        }
                    }
                }
                await page.waitForTimeout(5000);
            }
        } catch (e) {
            if (browser) await browser.close();
            await new Promise(r => setTimeout(r, 30000));
        }
    }
})();