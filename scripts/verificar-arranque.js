/**
 * Levanta el bot con credenciales falsas y verifica que arranca y que los
 * endpoints responden lo que tienen que responder.
 *
 * Existe porque `node --check` valida la sintaxis pero NO las referencias: una
 * variable que quedó sin declarar al mover código pasa el check y recién revienta
 * en runtime, dentro de un catch que se la traga. Este script mira los logs del
 * arranque y falla si aparece un ReferenceError.
 *
 * No pega contra Notion ni Google de verdad: los ❌ de credenciales son esperados
 * y justamente prueban que el /health reporta el estado real en vez de mentir.
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 8099;
const SECRET = 'secreto-de-prueba';
const RAIZ = path.join(__dirname, '..');

let fallos = 0;
function chequear(nombre, condicion, detalle = '') {
  console.log(`  ${condicion ? '✅' : '❌'} ${nombre}${!condicion && detalle ? ` — ${detalle}` : ''}`);
  if (!condicion) fallos++;
}

function pedir(metodo, ruta, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: ruta, method: metodo, headers }, res => {
      let cuerpo = '';
      res.on('data', d => { cuerpo += d; });
      res.on('end', () => resolve({ status: res.statusCode, cuerpo }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function esperarPuerto(intentos = 40) {
  for (let i = 0; i < intentos; i++) {
    try { await pedir('GET', '/health'); return true; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  return false;
}

(async () => {
  const bot = spawn(process.execPath, ['index.js'], {
    cwd: RAIZ,
    env: {
      ...process.env,
      PORT: String(PORT),
      CLAUDE_API_KEY: 'test', NOTION_TOKEN: 'test', NOTION_DATABASE_ID: 'test',
      TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_ALLOWED_USER_IDS: '1', CRON_SECRET: SECRET
    }
  });

  let logs = '';
  bot.stdout.on('data', d => { logs += d; });
  bot.stderr.on('data', d => { logs += d; });

  try {
    console.log('\nArranque');
    chequear('el server levanta', await esperarPuerto(), 'no respondió en 10 s');

    const salud = await pedir('GET', '/health');
    const json = JSON.parse(salud.cuerpo);
    chequear('/health responde 200', salud.status === 200, `HTTP ${salud.status}`);
    chequear('/health reporta el estado REAL de Notion', String(json.notion).startsWith('❌'),
      `notion: ${json.notion} (con un token falso no puede decir ✅)`);
    chequear('/health reporta el estado REAL de Calendar', String(json.calendar).startsWith('❌'),
      `calendar: ${json.calendar}`);
    chequear('/health avisa que falta "Fecha hecho"', String(json.propiedad_fecha_hecho).includes('⚠️'));

    console.log('\nEndpoints de cron protegidos');
    chequear('sin secret → 403', (await pedir('POST', '/cron/cierre-dia')).status === 403);
    chequear('secret incorrecto → 403',
      (await pedir('POST', '/cron/cierre-dia', { 'X-Cron-Secret': 'mal' })).status === 403);
    chequear('secret correcto → 200',
      (await pedir('POST', '/cron/cierre-dia', { 'X-Cron-Secret': SECRET })).status === 200);
    chequear('plan de la mañana también protegido',
      (await pedir('POST', '/cron/plan-dia')).status === 403);

    console.log('\nLimpieza');
    chequear('el webhook muerto de Google Chat ya no existe',
      (await pedir('POST', '/webhook/google-chat')).status === 404);

    await new Promise(r => setTimeout(r, 1500));   // dejar que terminen los logs asincrónicos

    console.log('\nLogs del arranque');
    const referencia = logs.match(/\w+ is not defined/);
    chequear('sin ReferenceError', !referencia, referencia && referencia[0]);
    chequear('sin "is not a function"', !/is not a function/.test(logs),
      (logs.match(/.*is not a function.*/) || [])[0]);
  } catch (e) {
    console.log(`  ❌ error inesperado — ${e.message}`);
    fallos++;
  } finally {
    bot.kill();
  }

  console.log(fallos === 0 ? '\n✅ Todo bien\n' : `\n❌ ${fallos} chequeo(s) fallaron\n`);
  process.exit(fallos === 0 ? 0 : 1);
})();
