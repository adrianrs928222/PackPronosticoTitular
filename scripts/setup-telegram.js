import 'dotenv/config';
const { TELEGRAM_BOT_TOKEN: token, PUBLIC_URL: url, TELEGRAM_WEBHOOK_SECRET: secret } = process.env;
if (!token || !url || !secret) throw Error('Configura TELEGRAM_BOT_TOKEN, PUBLIC_URL y TELEGRAM_WEBHOOK_SECRET');
const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({url: `${url.replace(/\/$/, '')}/webhooks/telegram`, secret_token: secret, allowed_updates: ['chat_join_request']})
});
const data = await res.json();
if (!data.ok) throw Error(data.description || 'No se pudo registrar webhook');
console.log('Webhook de Telegram configurado.');
