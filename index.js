const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const amqplib = require('amqplib');
const redis = require('redis');
const fs = require('fs');
const path = require('path');
const express = require('express');

const app = express();
app.use(express.json());

let amqpChannel = null;
let redisClient = null;
let isPaused = false;
let browserPage = null;

const IG_USER = process.env.IG_USERNAME;
const IG_PASS = process.env.IG_PASSWORD;
const INSTANCE_ID = process.env.INSTANCE_NAME || 'zennitex_01';
const RABBITMQ_URI = process.env.RABBITMQ_URI || 'amqp://localhost';
const REDIS_URI = process.env.REDIS_URI || 'redis://localhost:6379';
const BROWSER_DATA_DIR = `/app/browser_data/session_${IG_USER}`;

const logger = (lvl, mod, msg) => console.log(`[${new Date().toISOString()}] [${lvl}] [${mod}] ${msg}`);

async function initializeServices() {
    if (!amqpChannel) {
        const conn = await amqplib.connect(RABBITMQ_URI);
        amqpChannel = await conn.createChannel();
        await amqpChannel.assertQueue('mensagens', { durable: true });
        await amqpChannel.assertQueue('enviar_mensagem', { durable: true });
        logger('INFO', 'SERVICES', 'RabbitMQ OK');
    }
    if (!redisClient) {
        redisClient = redis.createClient({ url: REDIS_URI });
        await redisClient.connect();
        logger('INFO', 'SERVICES', 'Redis OK');
    }
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
        logger('INFO', 'AUTH', 'Enter enviado. Monitorando fluxo de entrada...');

        // 1. Espera sair da página de login (qualquer coisa que não seja accounts/login)
        await page.waitForFunction(() => !document.URL.includes('accounts/login'), { timeout: 60000 });

        // 2. Loop de bypass para OneTap e Notificações
        for (let i = 0; i < 3; i++) {
            const currentUrl = page.url();
            if (currentUrl.includes('direct/inbox')) break;

            if (currentUrl.includes('onetap') || currentUrl.includes('accounts/onetap')) {
                logger('INFO', 'AUTH', 'Detectado "Save Login Info". Tentando pular...');
                const notNowBtn = page.locator('button:has-text("Agora não"), button:has-text("Not Now"), [role="button"]:has-text("Agora não")').first();
                if (await notNowBtn.isVisible({ timeout: 5000 })) {
                    await notNowBtn.click().catch(() => { });
                    await page.waitForTimeout(2000);
                }
            }

            // Se ainda não estiver no inbox, força a navegação
            logger('INFO', 'AUTH', `Tentativa ${i + 1}: Forçando navegação para o Inbox...`);
            await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded' }).catch(() => { });
            await page.waitForTimeout(3000);
        }

        // 3. Validação Final
        await page.waitForURL('**/direct/inbox/**', { timeout: 30000 });

        await page.context().storageState({ path: `${BROWSER_DATA_DIR}/state.json` });
        logger('INFO', 'AUTH', '✅ Sessão persistida e OneTap ignorado!');
    } catch (err) {
        const stamp = Date.now();
        await page.screenshot({ path: `${BROWSER_DATA_DIR}/login_crash_${stamp}.png` });
        throw err;
    }
}

async function fetchInstagramAPI(page) {
    if (isPaused) return null;
    return await page.evaluate(async () => {
        try {
            const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1];
            const res = await fetch('/api/v1/direct_v2/inbox/?folder=0&thread_message_limit=10', {
                headers: { 'x-csrftoken': csrf || '', 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' }
            });
            return res.ok ? await res.json() : null;
        } catch (e) { return null; }
    });
}

app.post('/send', async (req, res) => {
    const { threadId, text } = req.body;
    if (!threadId || !text) return res.status(400).json({ error: 'Faltam dados' });
    try {
        const payload = JSON.stringify({ threadId, text });
        amqpChannel.sendToQueue('enviar_mensagem', Buffer.from(payload), { persistent: true });
        return res.json({ success: true, message: 'Ordem na fila' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

(async () => {
    if (!fs.existsSync(BROWSER_DATA_DIR)) fs.mkdirSync(BROWSER_DATA_DIR, { recursive: true });
    await initializeServices();

    app.listen(3000, () => logger('INFO', 'API', 'Porta 3000 pronta.'));

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

            logger('INFO', 'SYSTEM', '🚀 Direction API Online!');

            amqpChannel.consume('enviar_mensagem', async (msg) => {
                if (!msg) return;
                isPaused = true;
                const { threadId, text } = JSON.parse(msg.content.toString());
                try {
                    await browserPage.goto(`https://www.instagram.com/direct/t/${threadId}/`);
                    const box = browserPage.locator('div[role="textbox"]').first();
                    await box.waitFor({ state: 'visible' });
                    await box.click();
                    await browserPage.keyboard.type(text, { delay: 50 });
                    await browserPage.keyboard.press('Enter');
                    amqpChannel.ack(msg);
                } catch (e) { amqpChannel.nack(msg, false, false); }
                finally { isPaused = false; await browserPage.goto('https://www.instagram.com/direct/inbox/').catch(() => { }); }
            });

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
                                        const payload = {
                                            metadata: { instanceId: INSTANCE_ID },
                                            sender: { username: 'ig_user', threadId: thread.thread_id },
                                            message: { id: item.item_id, text: item.text }
                                        };
                                        amqpChannel.sendToQueue('mensagens', Buffer.from(JSON.stringify(payload)), { persistent: true });
                                        await redisClient.set(`seen:${INSTANCE_ID}:${item.item_id}`, '1', { EX: 86400 });
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
            logger('ERROR', 'CORE', `Morte: ${e.message}`);
            if (browser) await browser.close();
            await new Promise(r => setTimeout(r, 60000));
        }
    }
})();