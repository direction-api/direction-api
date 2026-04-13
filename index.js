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
let browserPage = null;

const IG_USER = process.env.IG_USERNAME;
const IG_PASS = process.env.IG_PASSWORD;
const INSTANCE_ID = process.env.INSTANCE_NAME;
const RABBITMQ_URI = process.env.RABBITMQ_URI || 'amqp://localhost';
const REDIS_URI = process.env.REDIS_URI || 'redis://localhost:6379';
const BROWSER_DATA_DIR = `/app/browser_data/session_${INSTANCE_ID}`;

const logger = (lvl, mod, msg) => console.log(`[${new Date().toISOString()}] [${lvl}] [${mod}] ${msg}`);

async function initializeServices() {
    for (let i = 0; i < 15; i++) {
        try {
            const conn = await amqplib.connect(RABBITMQ_URI);
            amqpChannel = await conn.createChannel();

            const mySendQueue = `enviar_mensagem_${INSTANCE_ID}`;
            await amqpChannel.assertQueue(mySendQueue, { durable: true });
            await amqpChannel.assertQueue('mensagens', { durable: true });

            redisClient = redis.createClient({ url: REDIS_URI });
            await redisClient.connect();

            logger('INFO', 'SERVICES', `Serviços online. Ouvindo fila: ${mySendQueue}`);
            return;
        } catch (e) {
            logger('WARN', 'SERVICES', `Aguardando infraestrutura... (Tentativa ${i + 1}/15)`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    throw new Error('Falha total ao conectar nos serviços.');
}

async function performLogin(page) {
    logger('WARN', 'AUTH', 'Tela de login detectada. Iniciando preenchimento...');
    try {
        await page.waitForLoadState('networkidle');
        const inputs = page.locator('input');
        await inputs.first().waitFor({ state: 'attached', timeout: 20000 });

        await inputs.nth(0).fill(IG_USER);
        await page.waitForTimeout(500);
        await inputs.nth(1).fill(IG_PASS);
        await page.waitForTimeout(1000);

        await page.keyboard.press('Enter');
        logger('INFO', 'AUTH', 'Enter enviado. Aguardando validação das credenciais...');

        await page.waitForFunction(() => !document.URL.includes('accounts/login'), { timeout: 60000 });

        logger('INFO', 'AUTH', `Redirecionado para: ${page.url()}`);

        await page.context().storageState({ path: `${BROWSER_DATA_DIR}/state.json` });
        logger('INFO', 'AUTH', '✅ Cookies de sessão ROUBADOS E SALVOS com sucesso!');

        await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 15000 });

    } catch (err) {
        logger('WARN', 'AUTH', 'Ocorreu um travamento, mas a sessão pode já estar garantida para o próximo boot.');
        throw err;
    }
}

async function fetchInstagramAPI(page) {
    if (isPaused) return null;
    return await page.evaluate(async () => {
        try {
            const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1];
            const res = await fetch('/api/v1/direct_v2/inbox/?folder=0', {
                headers: { 'x-csrftoken': csrf || '', 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' }
            });
            return res.ok ? await res.json() : null;
        } catch (e) { return null; }
    });
}

(async () => {
    if (!fs.existsSync(BROWSER_DATA_DIR)) fs.mkdirSync(BROWSER_DATA_DIR, { recursive: true });
    await initializeServices();

    while (true) {
        let browser = null;
        try {
            browser = await chromium.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            });

            const storagePath = `${BROWSER_DATA_DIR}/state.json`;
            const contextOptions = fs.existsSync(storagePath) ? { storageState: storagePath } : {};
            const context = await browser.newContext({
                ...contextOptions,
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
            });

            browserPage = await context.newPage();
            await browserPage.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded' });

            if (browserPage.url().includes('login') || browserPage.url().includes('accounts')) {
                await performLogin(browserPage);
            }

            logger('INFO', 'SYSTEM', '🚀 Instância do Bot Online!');

            // 📬 MOTOR DE ENVIO (OUTBOUND)
            amqpChannel.consume(`enviar_mensagem_${INSTANCE_ID}`, async (msg) => {
                if (!msg) return;
                isPaused = true;
                const { threadId, text } = JSON.parse(msg.content.toString());
                try {
                    await browserPage.goto(`https://www.instagram.com/direct/t/${threadId}/`, { waitUntil: 'domcontentloaded' });

                    const box = browserPage.locator('div[role="textbox"]').first();
                    await box.waitFor({ state: 'visible', timeout: 15000 });

                    // O SEGREDO: Focus e Click forçado atravessam qualquer overlay invisível
                    await box.focus();
                    await box.click({ force: true });

                    await browserPage.keyboard.type(text, { delay: 50 });
                    await browserPage.waitForTimeout(300); // Respiro pro React processar o DOM
                    await browserPage.keyboard.press('Enter');

                    amqpChannel.ack(msg);
                    logger('INFO', 'OUTBOUND', `✅ Mensagem enviada para a thread ${threadId}`);
                } catch (e) {
                    logger('ERROR', 'OUTBOUND', `Falha no envio: ${e.message}`);
                    amqpChannel.nack(msg, false, true); // Reenfileira a msg em caso de falha
                } finally {
                    isPaused = false;
                    await browserPage.goto('https://www.instagram.com/direct/inbox/').catch(() => { });
                }
            });

            // 📨 MOTOR DE RECEBIMENTO (INBOUND)
            while (true) {
                if (!isPaused) {
                    const data = await fetchInstagramAPI(browserPage);
                    if (data?.inbox?.threads) {
                        const myUserId = await browserPage.evaluate(() => document.cookie.match(/ds_user_id=([^;]+)/)?.[1]);

                        for (const thread of data.inbox.threads) {
                            for (const item of thread.items) {
                                if (item.item_type === 'text' && String(item.user_id) !== String(myUserId)) {
                                    const seen = await redisClient.get(`seen:${INSTANCE_ID}:${item.item_id}`);
                                    if (!seen) {
                                        const senderObj = thread.users.find(u => String(u.pk) === String(item.user_id));
                                        const realUsername = senderObj ? senderObj.username : 'desconhecido';

                                        const payload = {
                                            metadata: { instanceId: INSTANCE_ID },
                                            sender: { username: realUsername, threadId: thread.thread_id },
                                            message: { id: item.item_id, text: item.text }
                                        };

                                        amqpChannel.sendToQueue('mensagens', Buffer.from(JSON.stringify(payload)), { persistent: true });
                                        await redisClient.set(`seen:${INSTANCE_ID}:${item.item_id}`, '1', { EX: 86400 });
                                        logger('INFO', 'INBOUND', `📩 Nova mensagem recebida de @${realUsername}`);
                                    }
                                }
                            }
                        }
                    }
                }

                await browserPage.waitForTimeout(5000);
                if (browserPage.url().includes('login')) throw new Error('SESSION_LOST');
            }

        } catch (e) {
            logger('ERROR', 'CORE', `Morte detectada: ${e.message}`);
            if (browser) await browser.close().catch(() => { });
            await new Promise(r => setTimeout(r, 10000));
        }
    }
})();