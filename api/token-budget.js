// M2-01 D-10/D-12: monthly token budget, persisted as flat JSON.
const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = process.env.NODE_ENV === 'production'
  ? '/var/lib/iam-api/token-budget.json'
  : path.resolve(__dirname, '..', 'var', 'token-budget.json');

const FILE = process.env.TOKEN_BUDGET_PATH || DEFAULT_PATH;
const CAP = Number(process.env.TOKEN_BUDGET_MONTHLY || 2_000_000);

function currentPeriodKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function ensureDir() {
  const dir = path.dirname(FILE);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

function readState() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const s = JSON.parse(raw);
    if (s.period !== currentPeriodKey()) return { period: currentPeriodKey(), tokens: 0 };
    return s;
  } catch {
    return { period: currentPeriodKey(), tokens: 0 };
  }
}

function writeState(s) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(s), 'utf8');
}

function isExhausted() {
  return readState().tokens >= CAP;
}

function recordUsage(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  const s = readState();
  s.tokens += Math.floor(tokens);
  writeState(s);
}

module.exports = {
  isExhausted,
  recordUsage,
  currentPeriodKey,
  _stateFile: () => FILE,
  _cap: () => CAP,
};
