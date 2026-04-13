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

async function initializeServices(retries = 15, delay = 3000) {
    if (!amqpChannel) {
        for (let i = 1; i <= retries; i++) {
            try {
                const conn = await amqplib.connect(RABBITMQ_URI);
                amqpChannel = await conn.createChannel();
                await amqpChannel.assertQueue('mensagens', { durable: true });
                await amqpChannel.assertQueue('enviar_mensagem', { durable: true });
                logger('INFO', 'SERVICES', 'RabbitMQ conectado');
                break;
            } catch (err) {
                logger('WARN', 'SERVICES', `RabbitMQ tentativa ${i}/${retries}: ${err.message}`);
                if (i === retries) throw new Error(`RabbitMQ indisponível após ${retries} tentativas`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    if (!redisClient) {
        redisClient = redis.createClient({ url: REDIS_URI });
        await redisClient.connect();
        logger('INFO', 'SERVICES', 'Redis conectado');
    }
}


// 🛡️ O "Mata-Popups" da Zennitex (Melhorado para Cookies e Modais)
async function dismissPopups(page) {
    try {
        const popupSelectors = [
            'button:has-text("Agora não")',
            'div[role="button"]:has-text("Agora não")',
            'button:has-text("Permitir todos os cookies")',
            'button:has-text("Allow all cookies")',
            'button:has-text("Decline optional cookies")',
            'button:has-text("Recusar cookies opcionais")',
            'button:has-text("Aceitar tudo")',
            'button:has-text("Ajustar configurações")',
            'button:has-text("Recusar tudo")',
            'button:has-text("Accept all cookies")',
            'button:has-text("Decline all cookies")'
        ];

        for (const selector of popupSelectors) {
            const btn = page.locator(selector).first();
            if (await btn.isVisible({ timeout: 1000 })) {
                await btn.click({ timeout: 2000 }).catch(() => { });
                logger('INFO', 'SYSTEM', `Popup/Cookie interceptado e fechado: ${selector}`);
                await page.waitForTimeout(500);
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

            if (page.url().includes('login') || page.url().includes('accounts')) {
                logger('WARN', 'AUTH', 'Sessão expirada ou primeiro acesso. Iniciando login...');

                try {
                    await dismissPopups(page);


                    // Aguarda a página carregar completamente antes de procurar os campos
                    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
                    await page.waitForTimeout(1500 + Math.random() * 1000);
                    await dismissPopups(page);

                    // 1️⃣ Campo de usuário — múltiplos seletores para cobrir EN e PT-BR
                    const USER_SELECTORS = [
                        'input[name="username"]',
                        'input[name="email"]', // Adicionado conforme log
                        'input[aria-label*="usuário"]',
                        'input[aria-label*="username"]',
                        'input[aria-label*="celular"]',
                        'input[aria-label*="email"]',
                        'input[placeholder*="usuário"]',
                        'input[placeholder*="celular"]',
                        'input[placeholder*="email"]',
                        'input[autocomplete="username"]',
                        'input[type="text"]'   // último recurso
                    ].join(', ');

                    const userField = page.locator(USER_SELECTORS).first();
                    await userField.waitFor({ state: 'visible', timeout: 25000 });
                    logger('INFO', 'AUTH', 'Formulário encontrado. Preenchendo credenciais...');

                    // 2️⃣ Preencher usuário e senha com .fill() (mais rápido e dispara eventos React/DOM corretamente)
                    await userField.focus();
                    await userField.fill(IG_USER);
                    await page.waitForTimeout(500 + Math.random() * 500);

                    const passField = page.locator(PASS_SELECTORS).first();
                    await passField.waitFor({ state: 'visible', timeout: 10000 });
                    await passField.focus();
                    await passField.fill(IG_PASS);
                    await page.waitForTimeout(800 + Math.random() * 500);

                    // 4️⃣ Botão de submit
                    const SUBMIT_SELECTORS = [
                        'button[type="submit"]',
                        'button:has-text("Entrar")',
                        'div[role="button"]:has-text("Entrar")',
                        'button:has-text("Log in")',
                        'button:has-text("Log In")',
                        '[data-testid="royal_login_button"]',
                        'div[role="button"]:has-text("Log in")'
                    ].join(', ');

                    const submitBtn = page.locator(SUBMIT_SELECTORS).first();
                    try {
                        await submitBtn.waitFor({ state: 'visible', timeout: 15000 });
                        await submitBtn.click({ force: true });
                        logger('INFO', 'AUTH', 'Botão de login clicado.');
                    } catch (e) {
                        logger('WARN', 'AUTH', 'Botão de login não encontrado ou invisível. Tentando Enter...');
                        await page.keyboard.press('Enter');
                    }

                    // 5️⃣ Aguardar transição (Instagram é lento em VPS)
                    await page.waitForTimeout(10000);
                    
                    // Lidar com tela de "Salvar informações de login?"
                    const saveInfoBtn = page.locator('button:has-text("Salvar informações"), button:has-text("Save info")').first();
                    if (await saveInfoBtn.isVisible({ timeout: 5000 })) {
                        logger('INFO', 'AUTH', 'Tela "Salvar informações" detectada. Pulando...');
                        await saveInfoBtn.click().catch(() => {});
                        await page.waitForTimeout(3000);
                    }

                    await dismissPopups(page);

                    const currentUrl = page.url();
                    // Se ainda estiver na página de login e não houver desafio, fomos rejeitados
                    if ((currentUrl.includes('login') || currentUrl.includes('accounts')) && 
                        !currentUrl.includes('challenge') && !currentUrl.includes('two_factor') && !currentUrl.includes('checkpoint')) {
                        
                        logger('WARN', 'AUTH', 'Ainda na página de login. Tentando um Enter final...');
                        await page.keyboard.press('Enter');
                        await page.waitForTimeout(10000);
                        
                        if (page.url().includes('login')) {
                            logger('FATAL', 'AUTH', `Login rejeitado pelo Instagram. URL atual: ${page.url()}`);
                            throw new Error('LOGIN_REJECTED');
                        }
                    }


                    // 6️⃣ Detecta desafio de verificação (2FA / captcha / checkpoint)
                    if (currentUrl.includes('challenge') || currentUrl.includes('two_factor') || currentUrl.includes('checkpoint')) {
                        logger('WARN', 'AUTH', `⚠️  Verificação adicional necessária. URL: ${currentUrl}`);
                        logger('WARN', 'AUTH', 'Aguardando até 5 minutos para aprovação...');
                        await page.waitForURL('**/direct/inbox/**', { timeout: 300000 }).catch(() => { });
                    }

                } catch (err) {
                    if (err.message === 'LOGIN_REJECTED') throw err;
                    logger('FATAL', 'AUTH', `Erro no fluxo de login: ${err.message}`);
                    throw new Error('LOGIN_FORM_BLOCKED');
                }



                await page.waitForTimeout(2000);
                await dismissPopups(page);

                // Salva a sessão no Redis após login bem-sucedido
                await redisClient.set(`ai_session:${IG_USER}`, JSON.stringify(await context.storageState()));
                logger('INFO', 'AUTH', '✅ Sessão salva no Redis');

                // Navega para o inbox
                await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(2000);
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
            const isLoginError = e.message === 'LOGIN_FORM_BLOCKED' || e.message === 'LOGIN_REJECTED';
            if (e.message !== 'SESSION_LOST' && !String(e.message).includes('SESSION_LOST')) {
                logger('ERROR', 'CORE', `Crash Detectado: ${e.message}`);
            }
            if (engineInterval) clearInterval(engineInterval);
            if (browser) await browser.close();
            setBotPause(false);

            // Backoff maior para erros de login (evita banimento por tentativas em loop)
            const rebootDelay = isLoginError ? 120000 : 5000;
            logger('INFO', 'CORE', `Reboot do motor em ${rebootDelay / 1000}s...`);
            await new Promise(r => setTimeout(r, rebootDelay));
        }
    }
})();