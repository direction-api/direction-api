const express = require('express');
const router = express.Router();
const amqplib = require('amqplib');

const RABBITMQ_URI = process.env.RABBITMQ_URI || 'amqp://localhost';

// ROTA: POST /api/send/:token
router.post('/:token', async (req, res) => {
    const { token } = req.params;
    const { threadId, text } = req.body;

    if (!threadId || !text) {
        return res.status(400).json({ success: false, error: 'threadId e text são obrigatórios' });
    }

    try {
        const conn = await amqplib.connect(RABBITMQ_URI);
        const channel = await conn.createChannel();

        const payload = {
            threadId: threadId,
            text: text,
            timestamp: new Date().toISOString()
        };

        // Enviamos para a fila que o index.js já está escutando
        const sent = channel.sendToQueue('enviar_mensagem', Buffer.from(JSON.stringify(payload)), {
            persistent: true,
            contentType: 'application/json'
        });

        setTimeout(() => conn.close(), 500);

        if (sent) {
            return res.json({
                success: true,
                message: 'Mensagem enviada para a fila de processamento',
                data: payload
            });
        } else {
            throw new Error('Falha ao injetar na fila do RabbitMQ');
        }

    } catch (err) {
        console.error(`[API SEND ERROR] Token: ${token} |`, err.message);
        res.status(500).json({ success: false, error: 'Erro interno ao processar envio' });
    }
});

module.exports = router;