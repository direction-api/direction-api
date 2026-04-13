const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const amqplib = require('amqplib');
const redis = require('redis');
const { execSync } = require('child_process');
const dns = require('dns');

dns.setDefaultResultOrder('ipv4first');

// Configurações
const INSTANCE_ID = process.env.INSTANCE_NAME || 'instancia_local';
const IG_USER = process.env.IG_USERNAME;
const IG_PASS = process.env.IG_PASSWORD;
const RABBITMQ_URI = process.env.RABBITMQ_URI || 'amqp://localhost';
const REDIS_URI = process.env.REDIS_URI || 'redis://localhost:6379';
const BROWSER_DATA_DIR = './browser_data/session_' + IG_USER;

let amqpChannel = null;
let redisClient = null;
let isPaused = false;

function logger(level, module, message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] [${module}] ${message}`);
}

// ⌨️ Helper: Digitação humana real com atraso randômico
async function humanType(page, selector, text) {
    await page.waitForSelector(selector, { state: 'visible', timeout: 15000 });
    await page.focus(selector);
    for (const char of text) {
        await page.keyboard.type(char, { delay: Math.random() * 120 + 60 });
    }
}

async function initializeServices() {
    if (!amqpChannel) {
        try {
            const conn = await amqplib.connect(RABBITMQ_URI);
            amqpChannel = await conn.createChannel();
            await amqpChannel.assertQueue('mensagens', { durable: true });
            logger('INFO', 'SERVICES', 'RabbitMQ conectado');
        } catch (e) { logger('ERROR', 'SERVICES', `Rabbit Falhou: ${e.message}`); throw e; }
    }
    if (!redisClient) {
        redisClient = redis.createClient({ url: REDIS_URI });
        await redisClient.connect();
        logger('INFO', 'SERVICES', 'Redis conectado');
    }
}

// 🛡️ Mata-Popups aprimorado
async function dismissPopups(page) {
    try {
        const selectors = [
            'button:has-text("Agora não")',
            'button:has-text("Not Now")',
            'button:has-text("Salvar informações")',
            'button:has-text("Save info")',
            'button:has-text("Permitir todos os cookies")',
            'button:has-text("Aceitar tudo")',
            'div[role="button"]:has-text("Agora não")'
        ];
        for (const s of selectors) {
            const btn = page.locator(s).first();
            if (await btn.isVisible({ timeout: 1500 })) {
                await btn.click().catch(() => { });
                await page.waitForTimeout(800);
            }
        }
    } catch (e) { }
}

async function fetchInstagramAPI(page) {
    if (isPaused) return null;
    return await page.evaluate(async () => {
        try {
            const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1];
            if (!csrf) return { error: 'CSRF_MISSING' };
            const response = await fetch('/api/v1/direct_v2/inbox/?persistentBadging=true&folder=0&thread_message_limit=10', {
                method: 'GET',
                headers: { 'x-csrftoken': csrf, 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' }
            });
            if (!response.ok) return { error: `HTTP_${response.status}` };
            return await response.json();
        } catch (e) { return { error: 'FETCH_FAILED' }; }
    });
}

(async () => {
    while (true) {
        let context = null;
        try {
            await initializeServices();

            // Lançamento com Persistência
            context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
                headless: false, // 💡 MUDADO PARA FALSE: Ver o navegador ajuda a debugar localmente!
                args: [
                    '--no-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--window-size=1280,720'
                ],
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
            });

            const page = context.pages()[0] || await context.newPage();

            logger('INFO', 'AUTH', 'Navegando para o Inbox...');
            await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'networkidle' });
            await page.waitForTimeout(3000);

            // Fluxo de Login se necessário
            if (page.url().includes('login') || page.url().includes('accounts')) {
                logger('WARN', 'AUTH', 'Login detectado como necessário.');

                await dismissPopups(page); // Cookies costumam aparecer aqui

                const userSel = 'input[name="username"]';
                const passSel = 'input[name="password"]';

                await humanType(page, userSel, IG_USER);
                await page.waitForTimeout(1000);
                await humanType(page, passSel, IG_PASS);

                await page.waitForTimeout(1000);
                await page.click('button[type="submit"]');
                logger('INFO', 'AUTH', 'Aguardando autenticação...');

                // Espera o redirecionamento ou erro
                await page.waitForFunction(() => {
                    return !document.URL.includes('login') || document.body.innerText.includes('Incorreta');
                }, { timeout: 30000 });

                if (page.url().includes('login') && await page.content().then(c => c.includes('Incorreta'))) {
                    throw new Error('SENHA_INCORRETA');
                }
            }

            // Pós-login: Limpeza de terreno
            await page.waitForTimeout(5000);
            await dismissPopups(page);

            // Validação final de URL
            if (!page.url().includes('direct/inbox')) {
                await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'networkidle' });
            }

            logger('INFO', 'SYSTEM', '🚀 Direction API Online e Monitorando!');

            // Engine Loop
            while (true) {
                const data = await fetchInstagramAPI(page);

                if (data?.inbox?.threads) {
                    const myUserId = await page.evaluate(() => document.cookie.match(/ds_user_id=([^;]+)/)?.[1]);

                    for (const thread of data.inbox.threads) {
                        const otherUser = thread.users.find(u => String(u.pk) !== String(myUserId));
                        if (!otherUser) continue;

                        for (const item of thread.items) {
                            if (String(item.user_id) !== String(myUserId) && item.item_type === 'text') {
                                const msgId = item.item_id;
                                const seen = await redisClient.get(`seen:${INSTANCE_ID}:${msgId}`);

                                if (!seen) {
                                    const payload = {
                                        metadata: { instanceId: INSTANCE_ID },
                                        sender: { username: otherUser.username, threadId: thread.thread_id },
                                        message: { text: item.text }
                                    };
                                    amqpChannel.sendToQueue('mensagens', Buffer.from(JSON.stringify(payload)), { persistent: true });
                                    await redisClient.set(`seen:${INSTANCE_ID}:${msgId}`, '1', { EX: 86400 });
                                    logger('INFO', 'INBOUND', `Mensagem de @${otherUser.username} capturada.`);
                                }
                            }
                        }
                    }
                }

                await page.waitForTimeout(5000); // Poll de 5 segundos
                if (page.url().includes('login')) throw new Error('SESSION_LOST');
            }

        } catch (e) {
            logger('ERROR', 'CORE', `Crash: ${e.message}`);
            if (context) await context.close();
            const delay = e.message.includes('SENHA') ? 300000 : 60000;
            logger('INFO', 'CORE', `Reiniciando em ${delay / 1000}s...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
})();