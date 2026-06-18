const MODULE_NAME = 'character_wallet';
const PANEL_ID = 'char-wallet-panel';
const SETTINGS_ID = 'char-wallet-settings-root';
const UPDATE_RE = /<char_wallet_state>\s*(?:<!--\s*)?([\s\S]*?)(?:\s*-->)?\s*<\/char_wallet_state>/i;
const CLEANUP_RE = /\s*<char_wallet_state>\s*(?:<!--\s*)?[\s\S]*?(?:\s*-->)?\s*<\/char_wallet_state>\s*/gi;

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  panelOpen: true,
  injectState: true,
  cleanupBlocks: true,
  showDebug: false,
  language: 'auto',
});

const DEFAULT_STATE = Object.freeze({
  owner: '',
  balance: 0,
  currency: '$',
  living_wage: 1000,
  expenses: [],
  income: [],
  initialized: false,
  appliedUpdates: [],
  debugLog: [],
});

const LABELS = Object.freeze({
  ru: {
    debt: 'Долг',
    critical: 'Ниже минимума',
    thin: 'Тонкий запас',
    stable: 'Стабильно',
    empty: 'Пока пусто',
    balance: 'Баланс',
    minimum: 'Минимум',
    expenses: 'Расходы',
    income: 'Доходы',
    reset: 'Сбросить',
    collapse: 'Свернуть',
    open: 'Открыть',
  },
  en: {
    debt: 'In debt',
    critical: 'Below minimum',
    thin: 'Thin buffer',
    stable: 'Stable',
    empty: 'Nothing yet',
    balance: 'Balance',
    minimum: 'Minimum',
    expenses: 'Expenses',
    income: 'Income',
    reset: 'Reset',
    collapse: 'Collapse',
    open: 'Open',
  },
});

let initialized = false;
const registeredListeners = [];

function ctx() {
  return globalThis.SillyTavern?.getContext?.() ?? {};
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function hashText(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getTextFromMessage(message) {
  if (!message) return '';
  return String(message.mes ?? message.message ?? message.text ?? '');
}

function detectRecentLanguage() {
  const chat = Array.isArray(ctx().chat) ? ctx().chat : [];
  const recentText = chat.slice(-12).map(getTextFromMessage).join('\n');
  if (/[а-яА-ЯёЁ]/.test(recentText)) return 'ru';
  return 'en';
}

function uiLanguage() {
  const setting = getSettings().language;
  if (setting === 'ru' || setting === 'en') return setting;
  return detectRecentLanguage();
}

function labels() {
  return LABELS[uiLanguage()] ?? LABELS.en;
}

function getSettings() {
  const context = ctx();
  if (!context.extensionSettings) return clone(DEFAULT_SETTINGS);
  if (!context.extensionSettings[MODULE_NAME]) {
    context.extensionSettings[MODULE_NAME] = clone(DEFAULT_SETTINGS);
  }
  const settings = context.extensionSettings[MODULE_NAME];
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (!Object.hasOwn(settings, key)) settings[key] = value;
  }
  if (!['auto', 'ru', 'en'].includes(settings.language)) settings.language = 'auto';
  return settings;
}

function saveSettings() {
  ctx().saveSettingsDebounced?.();
}

function getCharacterName() {
  const context = ctx();
  return String(
    context.name2
    ?? context.character?.name
    ?? context.characters?.[context.characterId]?.name
    ?? context.char_name
    ?? '{{char}}',
  ).trim() || '{{char}}';
}

function getState() {
  const context = ctx();
  if (!context.chatMetadata) return clone(DEFAULT_STATE);
  if (!context.chatMetadata[MODULE_NAME]) {
    context.chatMetadata[MODULE_NAME] = clone(DEFAULT_STATE);
  }
  const state = context.chatMetadata[MODULE_NAME];
  for (const [key, value] of Object.entries(DEFAULT_STATE)) {
    if (!Object.hasOwn(state, key)) state[key] = clone(value);
  }
  if (!Array.isArray(state.expenses)) state.expenses = [];
  if (!Array.isArray(state.income)) state.income = [];
  if (!Array.isArray(state.appliedUpdates)) state.appliedUpdates = [];
  if (!Array.isArray(state.debugLog)) state.debugLog = [];
  state.initialized = state.initialized === true;
  state.balance = numberOr(state.balance, 0);
  state.living_wage = numberOr(state.living_wage, 1000);
  state.currency = String(state.currency || '$');
  state.owner = getCharacterName();
  return state;
}

async function saveState() {
  const context = ctx();
  if (typeof context.saveMetadata === 'function') {
    await context.saveMetadata();
  }
}

function pushDebug(state, status, message) {
  state.debugLog.unshift({
    status,
    message,
    at: new Date().toLocaleTimeString(),
  });
  state.debugLog = state.debugLog.slice(0, 8);
}

function normalizeWallet(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    owner: String(source.owner || getCharacterName()),
    balance: numberOr(source.balance, 0),
    currency: String(source.currency || '$'),
    living_wage: numberOr(source.living_wage, 1000),
    expenses: Array.isArray(source.expenses) ? source.expenses.map(item => ({
      id: String(item.id || hashText(`${item.name ?? 'expense'}:${item.amount ?? 0}`)),
      name: String(item.name || '?').slice(0, 90),
      amount: numberOr(item.amount, 0),
      paid: item.paid !== false,
      overdue_days: numberOr(item.overdue_days, 0),
      penalty: numberOr(item.penalty, 0),
      recurring: item.recurring === true,
      icon: String(item.icon || '$').slice(0, 8),
    })) : [],
    income: Array.isArray(source.income) ? source.income.map(item => ({
      id: String(item.id || hashText(`${item.name ?? 'income'}:${item.amount ?? 0}`)),
      name: String(item.name || '?').slice(0, 90),
      amount: numberOr(item.amount, 0),
      received: item.received !== false,
      recurring: item.recurring === true,
      icon: String(item.icon || '+').slice(0, 8),
    })) : [],
    initialized: true,
  };
}

function parseWalletBlock(text) {
  const match = String(text || '').match(UPDATE_RE);
  if (!match) return null;
  const cleaned = match[1].trim().replace(/^<!--\s*/, '').replace(/\s*-->$/, '');
  try {
    return normalizeWallet(JSON.parse(cleaned));
  } catch (error) {
    return null;
  }
}

function getLatestAssistantMessage(data) {
  const context = ctx();
  const chat = Array.isArray(context.chat) ? context.chat : [];
  const indexFromData = Number(data?.messageId ?? data?.message_id ?? data?.index ?? data);
  if (Number.isInteger(indexFromData) && chat[indexFromData] && chat[indexFromData].is_user !== true) {
    return { message: chat[indexFromData], index: indexFromData };
  }
  for (let index = chat.length - 1; index >= 0; index -= 1) {
    const message = chat[index];
    if (message && message.is_user !== true) return { message, index };
  }
  return { message: null, index: -1 };
}

function getMessageText(message) {
  return getTextFromMessage(message);
}

function setMessageText(message, value) {
  if (!message) return;
  if (typeof message.mes === 'string') message.mes = value;
  else if (typeof message.message === 'string') message.message = value;
  else if (typeof message.text === 'string') message.text = value;
}

function mergeWalletState(target, update) {
  target.owner = update.owner || getCharacterName();
  target.balance = update.balance;
  target.currency = update.currency;
  target.living_wage = update.living_wage;
  target.expenses = update.expenses;
  target.income = update.income;
  target.initialized = true;
}

async function processIncomingMessage(data) {
  const settings = getSettings();
  if (!settings.enabled) return;

  const state = getState();
  const { message, index } = getLatestAssistantMessage(data);
  const text = getMessageText(message);
  const match = text.match(UPDATE_RE);
  if (!match) {
    if (settings.showDebug) pushDebug(state, 'hold', 'no char_wallet_state block found');
    renderPanel();
    await saveState();
    return;
  }

  const updateId = `${index}:${hashText(match[0])}`;
  if (state.appliedUpdates.includes(updateId)) {
    if (settings.showDebug) pushDebug(state, 'hold', 'duplicate wallet update ignored');
    renderPanel();
    await saveState();
    return;
  }

  const parsed = parseWalletBlock(text);
  if (!parsed) {
    pushDebug(state, 'warn', 'wallet JSON parse failed');
    renderPanel();
    await saveState();
    return;
  }

  mergeWalletState(state, parsed);
  state.appliedUpdates.push(updateId);
  state.appliedUpdates = state.appliedUpdates.slice(-50);
  pushDebug(state, 'pass', 'character wallet updated');

  if (settings.cleanupBlocks) {
    setMessageText(message, text.replace(CLEANUP_RE, '\n').trim());
    ctx().saveChatConditional?.();
    if (settings.showDebug) pushDebug(state, 'clean', 'wallet block removed from message');
  }

  renderPanel();
  await saveState();
}

function buildPrompt() {
  const settings = getSettings();
  const state = getState();
  const hasEstablishedWallet = state.initialized === true;
  const languageRule = settings.language === 'ru'
    ? 'Use Russian for all human-readable text fields.'
    : settings.language === 'en'
      ? 'Use English for all human-readable text fields.'
      : 'Use the same language as the current roleplay conversation for all human-readable text fields.';
  const stateJson = JSON.stringify({
    owner: state.owner,
    balance: state.balance,
    currency: state.currency,
    living_wage: state.living_wage,
    expenses: state.expenses,
    income: state.income,
  });
  const stateInstruction = hasEstablishedWallet
    ? `Current established character wallet state: ${stateJson}`
    : `No established character wallet exists yet. Draft/default state, if any: ${stateJson}. Initialize the wallet from {{char}}'s character card, scenario, personality, active lore/world info, and visible chat context before applying the latest scene events.`;

  return [
    '[Character Wallet Strict]',
    'You maintain the personal wallet of {{char}} only. This is NOT {{user}}\'s wallet.',
    `${languageRule} Currency must match the story setting, not the UI language.`,
    stateInstruction,
    'After every assistant reply, append exactly one compact JSON object inside this tag at the very end:',
    '<char_wallet_state><!-- {"owner":"{{char}}","balance":0,"currency":"$","living_wage":1000,"expenses":[],"income":[]} --></char_wallet_state>',
    'Required JSON keys: owner, balance, currency, living_wage, expenses, income.',
    'Expense item keys: id, name, amount, paid, overdue_days, penalty, recurring, icon.',
    'Income item keys: id, name, amount, received, recurring, icon.',
    'Track only money that belongs to, is owed by, is owed to, is paid by, or is received by {{char}}.',
    'If {{user}} buys something with {{user}}\'s own money, do not update the character wallet. If {{char}} pays, earns, borrows, lends, receives a gift, gets robbed, owes a debt, pays rent, or has recurring obligations, update the wallet.',
    'Infer {{char}}\'s financial class, income sources, obligations, and spending habits from the roleplay and setting instead of forcing a fixed lifestyle template.',
    'Use only financial sources and obligations that are supported by the character card, chat history, current scene, or setting logic.',
    'On first initialization, choose a plausible liquid balance/cash reserve for {{char}}. Do not start from 0 unless the lore implies poverty, debt, or no access to money.',
    'On first initialization, also create a compact baseline cashflow profile from the lore: expected recurring income and mandatory recurring expenses that exist outside the current scene.',
    'Examples: salary, private practice, clinic/business revenue, royalties, rent income, allowance, investments, staff payroll, rent/mortgage, property upkeep, utilities, loans, taxes, medical costs, subscriptions, security, transport, dependents.',
    'Keep baseline items conservative and lore-grounded: usually 1-4 income items and 1-6 expense items. Do not invent a detailed budget when the card gives no support.',
    'Recurring income describes expected periodic cashflow. Do not add recurring income to balance again every message unless the scene advances to payday, rent collection, profit payout, or another explicit new accounting period.',
    'For wealthy, high-status, business-owning, royal, celebrity, executive, or otherwise resource-rich characters, initialize and maintain a balance appropriate to their accessible spending money, not their total net worth.',
    'If a previous draft/default wallet contradicts clear lore (for example a wealthy character going negative after ordinary luxury spending), correct the wallet to a plausible balance.',
    'For high-status or wealthy characters, scale income, reserves, gifts, staff, property upkeep, luxury purchases, and recurring obligations realistically when the story supports it.',
    'If {{char}} buys {{user}} a gift, pays for a date, purchases jewelry, covers a bill, or spends money to impress/protect/control someone, subtract it from {{char}}\'s balance and add/update an expense item.',
    'Keep recurring obligations unless the story explicitly ends them. Increase overdue_days and penalty when unpaid recurring expenses are neglected.',
    'If no financial change happened, repeat the complete current JSON with the same values.',
    'Output the tag on one line. Do not put Markdown code fences around it.',
    '[/Character Wallet Strict]',
  ].join('\n');
}

globalThis.charWalletInterceptor = async function charWalletInterceptor(chat) {
  const settings = getSettings();
  if (!settings.enabled || !settings.injectState || !Array.isArray(chat)) return;
  const insertAt = Math.max(0, chat.length - 1);
  chat.splice(insertAt, 0, {
    is_user: false,
    is_system: true,
    name: 'Character Wallet',
    mes: buildPrompt(),
  });
};

function money(value, currency) {
  const number = numberOr(value, 0);
  const abs = Math.abs(number);
  const formatted = abs >= 1000 ? Math.round(number).toLocaleString() : String(Math.round(number * 100) / 100);
  return `${formatted} ${currency}`;
}

function getStatus(state, text) {
  if (state.balance < 0) return { key: 'debt', label: text.debt, tone: 'danger' };
  if (state.balance < state.living_wage) return { key: 'critical', label: text.critical, tone: 'warn' };
  if (state.balance < state.living_wage * 2) return { key: 'thin', label: text.thin, tone: 'mid' };
  return { key: 'stable', label: text.stable, tone: 'ok' };
}

function sumItems(items, key = 'amount') {
  return items.reduce((total, item) => total + numberOr(item[key], 0), 0);
}

function itemRows(items, type, currency, text) {
  if (!items.length) return `<div class="cw-empty">${escapeHtml(text.empty)}</div>`;
  return items.map((item, index) => {
    const done = type === 'expense' ? item.paid : item.received;
    const locked = type === 'expense' && item.recurring;
    const overdue = type === 'expense' && item.overdue_days > 0
      ? `<span class="cw-pill danger">${escapeHtml(item.overdue_days)}d + ${escapeHtml(money(item.penalty, currency))}</span>`
      : '';
    return `
      <div class="cw-row ${done ? 'is-done' : 'is-open'}">
        <button class="cw-check" type="button" data-action="${type === 'expense' ? 'toggle-expense' : 'toggle-income'}" data-index="${index}" title="${done ? 'Mark open' : 'Mark done'}">${done ? '✓' : ''}</button>
        <div class="cw-icon">${escapeHtml(item.icon)}</div>
        <div class="cw-row-main">
          <div class="cw-row-title"><b>${escapeHtml(item.name)}</b></div>
          <div class="cw-row-meta">
            <span>${escapeHtml(money(item.amount, currency))}</span>
            ${item.recurring ? '<span class="cw-pill">recurring</span>' : ''}
            ${overdue}
          </div>
        </div>
        ${type === 'expense' && !locked ? `<button class="cw-small" type="button" data-action="delete-expense" data-index="${index}" title="Delete">×</button>` : ''}
      </div>`;
  }).join('');
}

function debugTemplate(log) {
  if (!getSettings().showDebug) return '';
  const rows = log.length ? log : [{ status: 'idle', message: 'waiting for char_wallet_state', at: '--:--' }];
  return `
    <section class="cw-section">
      <div class="cw-section-title">Debug</div>
      <div class="cw-debug">${rows.map(item => `
        <div class="cw-debug-line">
          <b>${escapeHtml(item.status)}</b>
          <span>${escapeHtml(item.message)} · ${escapeHtml(item.at)}</span>
        </div>`).join('')}</div>
    </section>`;
}

function renderPanel() {
  const settings = getSettings();
  const text = labels();
  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    panel = document.createElement('aside');
    panel.id = PANEL_ID;
    document.body.append(panel);
  }

  const state = getState();
  const status = getStatus(state, text);
  const expenseTotal = sumItems(state.expenses);
  const incomeTotal = sumItems(state.income);
  const survivalRatio = state.living_wage > 0 ? Math.max(0, Math.min(100, Math.round((state.balance / state.living_wage) * 100))) : 100;
  const unpaidCount = state.expenses.filter(item => item.paid === false).length;
  const openIncomeCount = state.income.filter(item => item.received === false).length;
  panel.className = `char-wallet ${settings.panelOpen ? 'is-open' : 'is-closed'}`;
  panel.innerHTML = `
    <button class="cw-tab" type="button" title="Character Wallet">$</button>
    <div class="cw-inner">
      <header class="cw-head">
        <div>
          <p class="cw-kicker">Character Wallet</p>
          <h2>${escapeHtml(state.owner || getCharacterName())}</h2>
        </div>
        <span class="cw-status ${status.tone}">${escapeHtml(status.label)}</span>
      </header>
      <div class="cw-balance">
        <div class="cw-card-shine"></div>
        <div class="cw-balance-grid">
          <div>
            <span>${escapeHtml(text.balance)}</span>
            <strong>${escapeHtml(money(state.balance, state.currency))}</strong>
            <small>${escapeHtml(text.minimum)}: ${escapeHtml(money(state.living_wage, state.currency))}</small>
          </div>
          <div class="cw-coin" aria-hidden="true">${escapeHtml(state.currency.slice(0, 2))}</div>
        </div>
        <div class="cw-meter" title="Living wage coverage">
          <div style="width:${survivalRatio}%"></div>
        </div>
        <div class="cw-ledger">
          <div><span>In</span><b>${escapeHtml(money(incomeTotal, state.currency))}</b></div>
          <div><span>Out</span><b>${escapeHtml(money(expenseTotal, state.currency))}</b></div>
          <div><span>Open</span><b>${escapeHtml(String(unpaidCount + openIncomeCount))}</b></div>
        </div>
      </div>
      <div class="cw-body">
        <section class="cw-section">
          <div class="cw-section-title">${escapeHtml(text.expenses)}</div>
          <div class="cw-list">${itemRows(state.expenses, 'expense', state.currency, text)}</div>
        </section>
        <section class="cw-section">
          <div class="cw-section-title">${escapeHtml(text.income)}</div>
          <div class="cw-list">${itemRows(state.income, 'income', state.currency, text)}</div>
        </section>
        ${debugTemplate(state.debugLog)}
        <div class="cw-actions">
          <button type="button" data-action="reset">${escapeHtml(text.reset)}</button>
          <button type="button" data-action="toggle">${settings.panelOpen ? escapeHtml(text.collapse) : escapeHtml(text.open)}</button>
        </div>
      </div>
    </div>`;

  bindPanelActions(panel);
}

function bindPanelActions(panel) {
  panel.querySelector('.cw-tab')?.addEventListener('click', () => {
    const settings = getSettings();
    settings.panelOpen = !settings.panelOpen;
    saveSettings();
    renderPanel();
  });

  panel.querySelectorAll('[data-action]').forEach(button => {
    button.addEventListener('click', async () => {
      const action = button.dataset.action;
      const index = Number(button.dataset.index);
      const settings = getSettings();
      const state = getState();

      if (action === 'toggle') settings.panelOpen = !settings.panelOpen;
      if (action === 'reset' && ctx().chatMetadata) ctx().chatMetadata[MODULE_NAME] = clone(DEFAULT_STATE);
      if (action === 'toggle-expense' && state.expenses[index]) {
        const expense = state.expenses[index];
        const total = numberOr(expense.amount, 0) + numberOr(expense.penalty, 0);
        if (expense.paid) {
          state.balance += total;
          expense.paid = false;
        } else {
          state.balance -= total;
          expense.paid = true;
          expense.overdue_days = 0;
          expense.penalty = 0;
        }
      }
      if (action === 'toggle-income' && state.income[index]) {
        const income = state.income[index];
        const total = numberOr(income.amount, 0);
        if (income.received) {
          state.balance -= total;
          income.received = false;
        } else {
          state.balance += total;
          income.received = true;
        }
      }
      if (action === 'delete-expense' && state.expenses[index] && !state.expenses[index].recurring) {
        state.expenses.splice(index, 1);
      }

      saveSettings();
      await saveState();
      renderPanel();
    });
  });
}

function renderSettings() {
  if (document.getElementById(SETTINGS_ID)) return;
  const host = document.querySelector('#extensions_settings2') ?? document.body;
  const wrapper = document.createElement('div');
  wrapper.id = SETTINGS_ID;
  wrapper.innerHTML = `
    <div class="cw-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>Character Wallet</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          ${settingCheckbox('cw-enabled', 'Enable character wallet')}
          ${settingCheckbox('cw-inject-state', 'Use main generation profile')}
          ${settingCheckbox('cw-cleanup', 'Hide <char_wallet_state> blocks in chat')}
          ${settingCheckbox('cw-debug', 'Show debug log')}
          <label for="cw-language">Language / Язык</label>
          <select id="cw-language" class="text_pole">
            <option value="auto">Auto / current chat</option>
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>
    </div>`;
  host.append(wrapper);

  bindSetting('enabled', '#cw-enabled', 'checked');
  bindSetting('injectState', '#cw-inject-state', 'checked');
  bindSetting('cleanupBlocks', '#cw-cleanup', 'checked');
  bindSetting('showDebug', '#cw-debug', 'checked');
  bindSetting('language', '#cw-language', 'value');
}

function settingCheckbox(id, text) {
  return `<label class="checkbox_label"><input id="${id}" type="checkbox"><span>${escapeHtml(text)}</span></label>`;
}

function bindSetting(key, selector, prop) {
  const settings = getSettings();
  const element = document.querySelector(selector);
  if (!element) return;
  element[prop] = settings[key];
  element.addEventListener('change', () => {
    settings[key] = element[prop];
    saveSettings();
    renderPanel();
  });
}

function registerListener(eventSource, eventType, handler) {
  if (!eventSource || !eventType || typeof eventSource.on !== 'function') return;
  eventSource.on(eventType, handler);
  registeredListeners.push({ eventSource, eventType, handler });
}

globalThis.charWalletOnDisable = function charWalletOnDisable() {
  for (const { eventSource, eventType, handler } of registeredListeners.splice(0)) {
    if (typeof eventSource.removeListener === 'function') {
      eventSource.removeListener(eventType, handler);
    } else if (typeof eventSource.off === 'function') {
      eventSource.off(eventType, handler);
    }
  }
  document.getElementById(PANEL_ID)?.remove();
  document.getElementById(SETTINGS_ID)?.remove();
  initialized = false;
};

async function onAppReady() {
  if (initialized) return;
  initialized = true;
  renderSettings();
  renderPanel();
  const { eventSource, event_types } = ctx();
  registerListener(eventSource, event_types?.MESSAGE_RECEIVED, processIncomingMessage);
  registerListener(eventSource, event_types?.CHAT_CHANGED, renderPanel);
  registerListener(eventSource, event_types?.MESSAGE_EDITED, processIncomingMessage);
  registerListener(eventSource, event_types?.MESSAGE_SWIPED, processIncomingMessage);
}

const context = ctx();
if (typeof document !== 'undefined') {
  if (context.eventSource && context.event_types?.APP_READY) {
    context.eventSource.on(context.event_types.APP_READY, onAppReady);
  }
  if (context.eventSource && context.event_types?.APP_INITIALIZED) {
    context.eventSource.on(context.event_types.APP_INITIALIZED, onAppReady);
  }
  if (document.readyState !== 'loading') {
    setTimeout(onAppReady, 0);
  } else {
    document.addEventListener('DOMContentLoaded', onAppReady, { once: true });
  }
}
