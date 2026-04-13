const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const amqplib = require('amqplib');
const redis = require('redis');
const { execSync } = require('child_process');
const dns = require('dns');

dns.setDefaultResultOrder('ipv4first');

const INSTANCE_ID = process.env.INSTANCE_NAME;
const IG_USER = process.env.IG_USERNAME;
const IG_PASS = process.env.IG_PASSWORD;
const RABBITMQ_URI = process.env.RABBITMQ_URI || 'amqp://localhost';
const REDIS_URI = process.env.REDIS_URI || 'redis://localhost:6379';

let amqpChannel = null;
let redisClient = null;

let isPaused = false;
let pauseTimeout = null;

function logger(level, module, message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] [${module}] ${message}`);
}

function setBotPause(state) {
    isPaused = state;
    if (state) {
        pauseTimeout = setTimeout(() => {
            if (isPaused) {
                isPaused = false;
                logger('WARN', 'SYSTEM', 'Trava de segurança ativada: isPaused resetado (45s)');
            }
        }, 45000);
    } else {
        if (pauseTimeout) clearTimeout(pauseTimeout);
    }
}

function cleanupZombies() {
    try {
        if (process.platform === 'win32') {
            execSync('wmic process where "name=\'chrome.exe\' and commandline like \'%--headless%\'" call terminate', { stdio: 'ignore' });
        } else {
            execSync('pkill -f "(chrome|chromium).*--headless"', { stdio: 'ignore' });
        }
    } catch (e) { }
}

async function initializeServices() {
    if (!amqpChannel) {
        const conn = await amqplib.connect(RABBITMQ_URI);
        amqpChannel = await conn.createChannel();
        await amqpChannel.assertQueue('mensagens', { durable: true });
        await amqpChannel.assertQueue('enviar_mensagem', { durable: true });
        logger('INFO', 'SERVICES', 'RabbitMQ & Redis connected');
    }
    if (!redisClient) {
        redisClient = redis.createClient({ url: REDIS_URI });
        await redisClient.connect();
    }
}

// 🛡️ O "Mata-Popups" da Zennitex
async function dismissPopups(page) {
    try {
        const popupBtn = page.locator('button:has-text("Agora não"), div[role="button"]:has-text("Agora não")').first();
        if (await popupBtn.isVisible({ timeout: 1500 })) {
            await popupBtn.click();
            logger('INFO', 'SYSTEM', 'Popup interceptado e fechado (Agora não).');
            await page.waitForTimeout(500);
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
                headers: {
                    'x-csrftoken': csrf,
                    'x-ig-app-id': '936619743392459',
                    'x-requested-with': 'XMLHttpRequest'
                }
            });

            if (response.status === 401 || response.status === 403) return { error: 'AUTH_EXPIRED' };
            return await response.json();
        } catch (e) { return null; }
    });
}

async function runEngine(page) {
    if (isPaused) return;

    const currentUrl = page.url();
    if (!currentUrl.includes('direct/inbox') && !currentUrl.includes('direct/t/')) {
        logger('WARN', 'CORE', `Redirecionado pela Meta (URL: ${currentUrl}). Tentando voltar...`);
        await dismissPopups(page);
        await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);

        if (!page.url().includes('direct/inbox')) {
            throw new Error('SESSION_LOST');
        }
        return;
    }

    const data = await fetchInstagramAPI(page);

    if (data?.error) {
        logger('WARN', 'AUTH', `Anomalia de API: ${data.error}`);
        if (data.error === 'AUTH_EXPIRED') throw new Error('SESSION_LOST');
        return;
    }

    if (!data?.inbox?.threads) return;

    const myUserId = await page.evaluate(() => document.cookie.match(/ds_user_id=([^;]+)/)?.[1]);

    for (const thread of data.inbox.threads) {
        const otherUser = thread.users.find(u => String(u.pk) !== String(myUserId));
        if (!otherUser) continue;

        const threadIdStr = String(thread.thread_id);

        for (const item of thread.items) {
            if (String(item.user_id) !== String(myUserId) && (item.item_type === 'text' || item.item_type === 'link')) {
                const msgId = item.item_id;
                const isProcessed = await redisClient.get(`seen:${INSTANCE_ID}:${msgId}`);

                if (!isProcessed) {
                    const text = item.item_type === 'text' ? item.text : item.link.text;
                    const cleanPayload = {
                        metadata: { event: 'MESSAGES_UPSERT', instanceId: INSTANCE_ID },
                        sender: { username: otherUser.username, threadId: threadIdStr },
                        message: { id: msgId, text: text }
                    };

                    amqpChannel.sendToQueue('mensagens', Buffer.from(JSON.stringify(cleanPayload)), {
                        persistent: true,
                        contentType: 'application/json'
                    });

                    await redisClient.set(`seen:${INSTANCE_ID}:${msgId}`, '1', { EX: 86400 });
                    logger('INFO', 'INBOUND', `Mensagem capturada: @${otherUser.username}`);
                }
            }
        }
    }
}

(async () => {
    cleanupZombies();
    while (true) {
        let browser = null;
        let engineInterval = null;

        try {
            await initializeServices();
            // 🛡️ HEADLESS VERDADEIRO DE PRODUÇÃO
            browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            const session = await redisClient.get(`ai_session:${IG_USER}`);

            // 🛡️ VIEWPORT FORÇADO: Garante que o navegador invisível tenha tamanho de notebook real
            const context = await browser.newContext({
                storageState: session ? JSON.parse(session) : undefined,
                viewport: { width: 1366, height: 768 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            });
            const page = await context.newPage();

            logger('INFO', 'AUTH', 'Acessando o Instagram...');
            await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(2000);
            await dismissPopups(page);

            if (page.url().includes('login')) {
                logger('WARN', 'AUTH', 'Login necessário. Aguardando a página renderizar...');

                try {
                    await dismissPopups(page);

                    const usernameLocator = page.locator('input[name="username"], input[type="text"], [aria-label*="usuário"]').first();
                    await usernameLocator.waitFor({ state: 'visible', timeout: 30000 });

                    logger('INFO', 'AUTH', 'Campo encontrado. Injetando credenciais...');
                    await usernameLocator.click();
                    await page.keyboard.type(IG_USER, { delay: 50 });
                    await page.keyboard.press('Tab');
                    await page.keyboard.type(IG_PASS, { delay: 50 });

                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { }),
                        page.keyboard.press('Enter')
                    ]);

                } catch (err) {
                    logger('FATAL', 'AUTH', 'O Instagram bloqueou o formulário ou timeout excedido.');
                    throw new Error('LOGIN_FORM_BLOCKED');
                }

                await page.waitForTimeout(3000);
                await dismissPopups(page);
                await dismissPopups(page);

                await redisClient.set(`ai_session:${IG_USER}`, JSON.stringify(await context.storageState()));
                await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded' });
            }

            logger('INFO', 'SYSTEM', 'Zennitex Gateway Pro V16.6 Online');
            setBotPause(false);

            engineInterval = setInterval(async () => {
                try {
                    await runEngine(page);
                } catch (e) {
                    if (e.message === 'SESSION_LOST' || String(e.message).includes('SESSION_LOST')) {
                        logger('FATAL', 'CORE', 'Sessão irrecuperável identificada.');
                        logger('INFO', 'AUTH', 'Purgando cookie envenenado AGORA...');

                        redisClient.del(`ai_session:${IG_USER}`).then(async () => {
                            clearInterval(engineInterval);
                            if (browser) await browser.close();
                            logger('INFO', 'CORE', 'Cookie destruído. Matando processo para o server.js reiniciar limpo...');
                            process.exit(1);
                        }).catch(() => {
                            process.exit(1);
                        });
                    }
                }
            }, 3000);

            // 2. MOTOR DE ENVIO (OUTBOUND)
            amqpChannel.consume('enviar_mensagem', async (msg) => {
                if (!msg) return;
                setBotPause(true);

                const { threadId, text } = JSON.parse(msg.content.toString());
                const cleanThreadId = String(threadId).trim();

                try {
                    logger('INFO', 'OUTBOUND', `Navegando para conversa: ${cleanThreadId}`);
                    await page.goto(`https://www.instagram.com/direct/t/${cleanThreadId}/`, { waitUntil: 'domcontentloaded' });
                    await page.waitForTimeout(1500);

                    await dismissPopups(page);

                    const textBox = page.locator('div[role="textbox"][contenteditable="true"], textarea').first();
                    await textBox.waitFor({ state: 'visible', timeout: 15000 });

                    // 🛡️ SOLUÇÃO DEFINITIVA: Injeção direta de Foco
                    await textBox.evaluate(node => node.focus());
                    await page.waitForTimeout(200);

                    await page.keyboard.type(text, { delay: 50 });

                    // 🛡️ PAUSA CRÍTICA: Dá tempo do Lexical Editor armar o botão de enviar
                    await page.waitForTimeout(500);

                    await page.keyboard.press('Enter');

                    await page.waitForTimeout(1500);
                    logger('INFO', 'OUTBOUND', '✅ Mensagem enviada com sucesso');
                    amqpChannel.ack(msg);
                } catch (e) {
                    logger('ERROR', 'OUTBOUND', `Falha no envio: ${e.message}`);
                    amqpChannel.nack(msg, false, false);
                } finally {
                    try { await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded' }); } catch (err) { }
                    setBotPause(false);
                }
            });

            await new Promise(() => { });

        } catch (e) {
            if (e.message !== 'SESSION_LOST' && !String(e.message).includes('SESSION_LOST')) {
                logger('ERROR', 'CORE', `Crash Detectado: ${e.message}`);
            }
            logger('INFO', 'CORE', 'Reboot do motor em 5s...');
            if (engineInterval) clearInterval(engineInterval);
            if (browser) await browser.close();
            setBotPause(false);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
})();