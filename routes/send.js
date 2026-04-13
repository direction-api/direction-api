const express = require('express');
const router = express.Router();
const amqplib = require('amqplib');

router.post('/:token', async (req, res) => {
    const { token } = req.params;
    const { threadId, text } = req.body;

    try {
        const conn = await amqplib.connect(process.env.RABBITMQ_URI);
        const channel = await conn.createChannel();

        // Fila dinâmica baseada no TOKEN da instância
        const targetQueue = `enviar_mensagem_${token}`;
        await channel.assertQueue(targetQueue, { durable: true });

        const payload = { threadId, text };
        channel.sendToQueue(targetQueue, Buffer.from(JSON.stringify(payload)), { persistent: true });

        setTimeout(() => conn.close(), 500);
        res.json({ success: true, message: `Mensagem enviada para a fila da instância ${token}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;