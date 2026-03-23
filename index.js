require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Bot } = require('@maxhub/max-bot-api');

// ============ Конфигурация ============
const MAX_BOT_TOKEN = process.env.MAX_BOT_TOKEN || process.env.BOT_TOKEN;
const MAX_ALERT_CHAT_ID = Number(process.env.MAX_ALERT_CHAT_ID);
const TEMP_API_URL = process.env.TEMP_API_URL || 'http://192.168.4.252:9001/api/latest';
const TEMP_THRESHOLD = Number(process.env.TEMP_THRESHOLD) || 50;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 60 * 1000; // 1 мин
const REPEAT_ALERT_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 часа
const TEMP_JSON_PATH = process.env.TEMP_JSON_PATH || '0.temperature';
const STATE_FILE = path.resolve(process.env.STATE_FILE || path.join(__dirname, 'bot-state.json'));

// ============ Состояние ============
let state = 'NORMAL'; // NORMAL | ALERTING
let lastAlertAt = null;
let repeatAlertTimer = null;

function loadPersistedState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.state === 'ALERTING' || data.state === 'NORMAL') {
      state = data.state;
    }
    if (typeof data.lastAlertAt === 'number' && Number.isFinite(data.lastAlertAt)) {
      lastAlertAt = data.lastAlertAt;
    }
    console.log(`Загружено состояние из ${STATE_FILE}: state=${state}, lastAlertAt=${lastAlertAt ? new Date(lastAlertAt).toISOString() : '—'}`);
  } catch (err) {
    console.warn('Не удалось прочитать состояние, начинаем с NORMAL:', err.message);
    state = 'NORMAL';
    lastAlertAt = null;
  }
}

function savePersistedState() {
  try {
    const payload = { state, lastAlertAt };
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('Ошибка записи состояния:', err.message);
  }
}

if (!MAX_BOT_TOKEN) {
  console.error('Укажите MAX_BOT_TOKEN (или BOT_TOKEN) в .env');
  process.exit(1);
}
if (!Number.isFinite(MAX_ALERT_CHAT_ID)) {
  console.error('Укажите MAX_ALERT_CHAT_ID — числовой id чата MAX для алертов');
  process.exit(1);
}

const bot = new Bot(MAX_BOT_TOKEN);

// ——— Логирование MAX API в консоль ———
function maxLog(direction, method, data) {
  const ts = new Date().toISOString();
  console.log(`[MAX API] ${ts} ${direction} ${method}`, data);
}
const origSendMessageToChat = bot.api.sendMessageToChat.bind(bot.api);
bot.api.sendMessageToChat = async function (chatId, text, extra) {
  const preview = typeof text === 'string' ? text.slice(0, 120) : String(text).slice(0, 120);
  maxLog('→', 'sendMessageToChat', {
    chat_id: chatId,
    text_preview: preview + (preview.length >= 120 ? '…' : ''),
  });
  try {
    const message = await origSendMessageToChat(chatId, text, extra);
    maxLog('←', 'sendMessageToChat', { chat_id: chatId, ok: true });
    return message;
  } catch (err) {
    maxLog('←', 'sendMessageToChat', { chat_id: chatId, error: err.message });
    throw err;
  }
};
bot.use(async (ctx, next) => {
  if (ctx.updateType === 'message_created' && ctx.message?.body) {
    const text = ctx.message.body.text || '';
    maxLog('←', 'message_created', {
      chat_id: ctx.chatId,
      user_id: ctx.user?.user_id,
      text: text.slice(0, 100) + (text.length > 100 ? '…' : ''),
    });
  }
  return next();
});
// ———

function getNested(obj, pathStr) {
  return pathStr.split('.').reduce((o, key) => (o && o[key] !== undefined ? o[key] : null), obj);
}

async function fetchTemperature() {
  const res = await axios.get(TEMP_API_URL, { timeout: 10000 });
  const value = getNested(res.data, TEMP_JSON_PATH);
  if (value === null || typeof value !== 'number') {
    throw new Error(`Температура не найдена по пути "${TEMP_JSON_PATH}" в ответе API`);
  }
  return value;
}

async function getTemperatureReplyText() {
  const temp = await fetchTemperature();
  const over = temp > TEMP_THRESHOLD;
  return (
    `🌡 Температура: ${temp}°C\n` +
    `📊 Порог: ${TEMP_THRESHOLD}°C\n` +
    `${over ? '⚠️ Сейчас выше порога' : '✅ Сейчас не выше порога'}\n` +
    `📌 Мониторинг: ${state === 'ALERTING' ? 'режим превышения' : 'норма'}`
  );
}

function setupCommands() {
  bot.command('temp', async (ctx) => {
    try {
      const text = await getTemperatureReplyText();
      await ctx.reply(text);
    } catch (err) {
      await ctx.reply(`❌ Не удалось получить температуру: ${err.message}`);
    }
  });

  bot.command('start', async (ctx) => {
    await ctx.reply(
      'Бот мониторит температуру и шлёт алерты в настроенный чат MAX.\n\n' +
        'Команды:\n' +
        '/temp — текущая температура с API'
    );
  });

  bot.api
    .setMyCommands([
      { name: 'temp', description: 'Текущая температура' },
      { name: 'start', description: 'Справка' },
    ])
    .catch((err) => {
      console.warn('setMyCommands:', err.message);
    });
}

function sendAlert(message) {
  bot.api.sendMessageToChat(MAX_ALERT_CHAT_ID, message).catch((err) => {
    console.error('Ошибка отправки в MAX:', err.message);
  });
}

/** @param {number} [delayMs] */
function scheduleRepeatAlert(delayMs) {
  if (repeatAlertTimer) clearTimeout(repeatAlertTimer);
  const delay = delayMs !== undefined ? delayMs : REPEAT_ALERT_INTERVAL_MS;
  repeatAlertTimer = setTimeout(() => {
    repeatAlertTimer = null;
    lastAlertAt = Date.now();
    savePersistedState();
    sendAlert(`⚠️ Повторный алерт: температура всё ещё выше ${TEMP_THRESHOLD}°C. Проверьте датчик.`);
    if (state === 'ALERTING') scheduleRepeatAlert();
  }, delay);
}

function restoreRepeatAlertTimerIfAlerting() {
  if (state !== 'ALERTING') return;
  if (lastAlertAt == null) {
    scheduleRepeatAlert(REPEAT_ALERT_INTERVAL_MS);
    return;
  }
  const nextDue = lastAlertAt + REPEAT_ALERT_INTERVAL_MS;
  const delay = Math.max(0, nextDue - Date.now());
  scheduleRepeatAlert(delay);
}

function cancelRepeatAlert() {
  if (repeatAlertTimer) {
    clearTimeout(repeatAlertTimer);
    repeatAlertTimer = null;
  }
}

async function checkTemperature() {
  let temp;
  try {
    temp = await fetchTemperature();
  } catch (err) {
    console.error('Ошибка запроса к API температуры:', err.message);
    return;
  }

  const isOver = temp > TEMP_THRESHOLD;

  if (state === 'NORMAL') {
    if (isOver) {
      state = 'ALERTING';
      lastAlertAt = Date.now();
      savePersistedState();
      sendAlert(
        `🔥 Превышение температуры!\n` +
          `Текущая: ${temp}°C (порог: ${TEMP_THRESHOLD}°C)\n` +
          `Следующий алерт через 4 часа, если температура не снизится.`
      );
      scheduleRepeatAlert();
    }
    return;
  }

  if (state === 'ALERTING') {
    if (isOver) {
      // повтор по таймеру
    } else {
      state = 'NORMAL';
      lastAlertAt = null;
      savePersistedState();
      cancelRepeatAlert();
      sendAlert(
        `✅ Температура в норме.\n` +
          `Текущая: ${temp}°C (порог: ${TEMP_THRESHOLD}°C). Ожидаем следующего повышения.`
      );
    }
  }
}

async function run() {
  loadPersistedState();
  setupCommands();
  restoreRepeatAlertTimerIfAlerting();
  console.log(
    `Мониторинг: ${TEMP_API_URL}, порог ${TEMP_THRESHOLD}°C, опрос каждые ${POLL_INTERVAL_MS / 1000} с, алерты в чат ${MAX_ALERT_CHAT_ID}, состояние: ${STATE_FILE}`
  );
  checkTemperature();
  setInterval(checkTemperature, POLL_INTERVAL_MS);
  await bot.start();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
