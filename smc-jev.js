/* ============================================================
   SMC-JEV.JS — OPTIONAL module. Nothing else in the suite depends on it.
   If this file is absent, blocked or unconfigured, the Verdict tab runs
   on the rules engine alone (SMCEngine.baseVerdict).

   Jev (TypeSafe "System One") does not generate text. It takes a `state`
   and typed questions and returns calibrated probabilities. Here it acts
   as a second opinion on whether the *described* setup satisfies the
   framework's criteria.

   AUTHORITY RULE: Jev may DOWNGRADE a verdict but can never UPGRADE one.
   Anything code can compute (time, killzone, R:R) stays in code.

   BACKENDS: any System One-compatible endpoint works — TypeSafe Jev, or the
   open-source OpenJev server (independent project, not affiliated with
   TypeSafe; quality differs from published Jev — calibrate on your own log).

   NOTE: request/response shapes follow the public System One docs
   (POST {base}/v1/systemone, Bearer auth, answers keyed by question id).
   Not verified against a live key at build time — normalize() is
   defensive, and testConnection() exists so the first real run reports
   exactly what the endpoint returns.
   ============================================================ */
const SMCJev = (function () {
  const CFG_KEY = 'smc_jev_cfg';

  const PROVIDERS = {
    typesafe:   { label: 'TypeSafe (direct)', baseUrl: 'https://api.typesafe.ai',    model: 'jev-latest', needsKey: true  },
    openrouter: { label: 'OpenRouter',        baseUrl: 'https://openrouter.ai/api',  model: 'jev-1.13',   needsKey: true  },
    openjev:    { label: 'OpenJev (open source, hosted)', baseUrl: 'https://api.codiv.ai', model: 'openjev-latest', needsKey: true },
    custom:     { label: 'Custom / proxy',    baseUrl: '',                           model: 'jev-latest', needsKey: false },
  };

  // Tunable thresholds — calibrate against logged outcomes.
  const T = {
    concern: 0.40,        // support below this counts as a concern
    hardFail: 0.25,       // required question below this counts double
    lowConfidence: 0.50,  // below this the answer is treated as uncertain
    noScore: 3,           // weighted concerns >= this  => 'no'
    waitScore: 1,         // weighted concerns >= this  => 'wait'
  };

  // positive:true  => a high yes-probability SUPPORTS the trade
  // positive:false => a high yes-probability is a RED FLAG
  // required:true  => framework treats it as non-negotiable
  const QUESTIONS = {
    aligned:  { type: 'noul', positive: true,  required: false,
      instructions: 'Is the intended trade direction consistent with the stated weekly/daily bias and the stated draw on liquidity?' },
    swept:    { type: 'noul', positive: true,  required: true,
      instructions: 'Does the setup describe opposing liquidity (a previous high or low, equal highs or lows, or a session extreme) being swept BEFORE the move away?' },
    cisod:    { type: 'noul', positive: true,  required: true,
      instructions: 'Does the setup describe displacement confirmed by a CLOSED candle that either cuts through a fair value gap or creates a market structure shift on the 15M or 5M?' },
    location: { type: 'noul', positive: true,  required: false,
      instructions: 'Is the entry located in the correct half of the range for the stated direction: discount for longs, premium for shorts?' },
    chop:     { type: 'noul', positive: false, required: false,
      instructions: 'Does the description indicate consolidation or a seek-and-destroy market, where both buy-side and sell-side liquidity are being taken without a clear direction?' },
    phase:    { type: 'choice',
      instructions: 'Which phase of the daily cycle does the described price action show?',
      criteria: {
      accumulation: 'Price is consolidating and building orders in a range',
      manipulation: 'Price is running liquidity against the intended direction (Judas swing / stop run)',
      distribution: 'Price is expanding in the intended direction after manipulation',
      unclear:      'The description does not make the phase clear' } },
  };

  class JevError extends Error {
    constructor(kind, message) { super(message); this.kind = kind; }
  }

  // ── config ──────────────────────────────────────
  function getConfig() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || 'null') || { provider: 'typesafe', baseUrl: PROVIDERS.typesafe.baseUrl, model: PROVIDERS.typesafe.model, key: '' }; }
    catch (e) { return { provider: 'typesafe', baseUrl: PROVIDERS.typesafe.baseUrl, model: PROVIDERS.typesafe.model, key: '' }; }
  }
  function saveConfig(cfg) { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }
  function clearConfig() { localStorage.removeItem(CFG_KEY); }
  function isConfigured() {
    const c = getConfig();
    if (!c.baseUrl || !c.model) return false;
    const p = PROVIDERS[c.provider] || PROVIDERS.custom;
    return p.needsKey ? !!c.key : true;
  }

  // ── request building ────────────────────────────
  function questionsForRequest() {
    const out = {};
    Object.entries(QUESTIONS).forEach(([id, q]) => {
      out[id] = q.type === 'choice'
        ? { type: 'choice', instructions: q.instructions, criteria: q.criteria }
        : { type: 'noul', instructions: q.instructions };
    });
    return out;
  }

  const LABELS = {
    weekly_daily_bias: 'Weekly/Daily bias', monthly_context: 'Monthly context',
    dol_identified: 'Draw on liquidity identified', erl_irl_aligned: 'External/internal range liquidity aligned',
    session: 'Session', stage_model: 'Stage model', htf_array_present: 'HTF PD array present',
    htf_array_tf: 'HTF array timeframe', cisod_displacement: 'Displacement confirmed (user-asserted)',
    cisod_confirmation: 'Confirmation type', cisod_tf: 'CISOD timeframe',
    entry_array_type: 'Entry array', rr_ratio: 'Risk:Reward', target_identified: 'Liquidity target identified',
  };
  function buildState(engineState, userText) {
    const lines = [];
    Object.keys(LABELS).forEach(k => {
      const v = engineState ? engineState[k] : null;
      if (v === null || v === undefined || v === '') return;
      lines.push(LABELS[k] + ': ' + (v === true ? 'yes' : v === false ? 'no' : v));
    });
    let state = lines.length ? 'Structured inputs from the trader:\n' + lines.join('\n') : '';
    if (userText && userText.trim()) state += (state ? '\n\n' : '') + "Trader's description of the chart:\n" + userText.trim();
    return state;
  }

  // ── network ─────────────────────────────────────
  async function post(state, questions) {
    const cfg = getConfig();
    if (!isConfigured()) throw new JevError('not_configured', 'Jev is not configured.');
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/v1/systemone';
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.key) headers['Authorization'] = 'Bearer ' + cfg.key;
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ model: cfg.model, state, questions }) });
    } catch (e) {
      throw new JevError('network', 'Could not reach Jev (network error or the endpoint blocks browser requests). If you have access, route calls through a small proxy such as a Cloudflare Worker and use "Custom / proxy".');
    }
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = (j && (j.error && (j.error.message || j.error) || j.message)) || ''; } catch (e) {}
      const map = { 401: ['auth', 'Jev rejected the key (401).'], 403: ['auth', 'Jev rejected the key or you lack access (403).'],
        402: ['quota', 'Jev reports a billing/credit problem (402).'], 429: ['quota', 'Jev rate limit reached (429). Try again shortly.'],
        400: ['request', 'Jev rejected the request (400).'], 422: ['request', 'Jev rejected the request (422).'] };
      const [kind, msg] = map[res.status] || (res.status >= 500 ? ['server', 'Jev had a server error (' + res.status + ').'] : ['request', 'Jev request failed (' + res.status + ').']);
      throw new JevError(kind, msg + (detail ? ' ' + String(detail).slice(0, 160) : ''));
    }
    let data;
    try { data = await res.json(); } catch (e) { throw new JevError('parse', 'Jev returned a response that was not valid JSON.'); }
    return data;
  }

  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  function normalize(data) {
    const answers = data && data.answers;
    if (!answers || typeof answers !== 'object') throw new JevError('parse', 'Jev response had no "answers" object.');
    const out = {};
    Object.entries(QUESTIONS).forEach(([id, q]) => {
      const a = answers[id]; if (!a || typeof a !== 'object') return;
      if (q.type === 'noul') {
        const p = [a.noul, a.probability, a.yes].map(num).find(v => v !== null);
        if (p !== undefined) out[id] = { type: 'noul', p: Math.max(0, Math.min(1, p)), confidence: num(a.confidence) };
      } else {
        out[id] = { type: 'choice', choice: a.choice || null, probabilities: a.probabilities || {}, confidence: num(a.confidence) };
      }
    });
    if (!Object.keys(out).length) throw new JevError('parse', 'Jev response contained none of the expected answers.');
    return { answers: out, model: data.model || null };
  }

  async function evaluate(state) {
    if (!state || state.length < 20) throw new JevError('request', 'Not enough context to review yet.');
    return normalize(await post(state, questionsForRequest()));
  }

  async function testConnection() {
    const data = await post('Test: price swept the previous day high and then closed back below it.',
      { ping: { type: 'noul', instructions: 'Did price sweep a previous high?' } });
    const a = data && data.answers && data.answers.ping;
    if (!a) throw new JevError('parse', 'Connected, but the response had no answer for the test question.');
    return { ok: true, model: data.model || getConfig().model, sample: a };
  }

  // ── review: can only downgrade ──────────────────
  const ORDER = ['incomplete', 'no', 'wait', 'meets'];
  function review(base, parsed) {
    const concerns = [], uncertain = [], supports = {};
    Object.entries(QUESTIONS).forEach(([id, q]) => {
      if (q.type !== 'noul') return;
      const a = parsed.answers[id]; if (!a) return;
      const support = q.positive ? a.p : 1 - a.p;
      supports[id] = support;
      if (a.confidence !== null && a.confidence < T.lowConfidence) {
        uncertain.push({ id, required: q.required });
        return;                                   // low confidence: never counts as evidence against
      }
      if (support < T.concern) concerns.push({ id, support, weight: (q.required && support < T.hardFail) ? 2 : 1, required: q.required });
    });
    let weight = concerns.reduce((s, c) => s + c.weight, 0);
    if (uncertain.some(u => u.required)) weight = Math.max(weight, T.waitScore);

    let level = base.level;
    if (base.level === 'meets') {
      if (weight >= T.noScore) level = 'no';
      else if (weight >= T.waitScore) level = 'wait';
    }
    // never upgrade
    if (ORDER.indexOf(level) > ORDER.indexOf(base.level)) level = base.level;
    const phase = parsed.answers.phase || null;
    return { level, baseLevel: base.level, changed: level !== base.level, concerns, uncertain, supports, phase,
             disagreement: base.level === 'meets' && level !== 'meets' };
  }

  return { PROVIDERS, QUESTIONS, THRESHOLDS: T, JevError, getConfig, saveConfig, clearConfig, isConfigured,
           buildState, questionsForRequest, evaluate, testConnection, normalize, review };
})();
