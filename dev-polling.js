// Desarrollo local SIN webhook: hace getUpdates en loop y pasa cada update
// al mismo handler que usa el webhook. Uso: npm run dev
// (Antes borra el webhook si estaba seteado; al desplegar hay que volver a setWebhook.)

require('dotenv').config();

// En Windows, el "Happy Eyeballs" de Node (autoSelectFamily) hace que las
// conexiones a api.telegram.org queden en ETIMEDOUT cuando la red no tiene
// IPv6 usable. En Cloud Run (Linux) no pasa; esto es solo para desarrollo local.
if (process.platform === 'win32') require('net').setDefaultAutoSelectFamily(false);

const { manejarUpdate } = require('./index');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;

async function main() {
  if (!TOKEN) {
    console.error('❌ Falta TELEGRAM_BOT_TOKEN en .env');
    process.exit(1);
  }

  const del = await (await fetch(`${API}/deleteWebhook`)).json();
  console.log(`🧹 deleteWebhook: ${del.ok ? 'ok' : JSON.stringify(del)}`);
  console.log('🔄 Polling iniciado (Ctrl+C para salir)...');

  let offset = 0;
  while (true) {
    try {
      const resp = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`);
      const data = await resp.json();
      if (!data.ok) {
        console.error('⚠️ getUpdates:', JSON.stringify(data));
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      for (const update of data.result) {
        offset = update.update_id + 1;
        manejarUpdate(update).catch(e => console.error('❌', e.message));
      }
    } catch (e) {
      console.error('⚠️ Polling error:', e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

main();
