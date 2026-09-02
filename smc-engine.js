// ============================================================
// SMC-ENGINE.JS — Decision Engine Logic
// SMC Suite
// Rebuilt around NZT's DSE framework: Direction → Stage → Entry.
// This is SEQUENTIAL GATING, not parallel weighted scoring.
// "No stage = no trade." Stage cannot be evaluated until Direction
// passes. Entry cannot be evaluated until Stage passes.
// ============================================================

const SMCEngine = {

  // ── CURRENT STATE ─────────────────────────────────────────
  state: {
    // ── DIRECTION ── (Weekly/Daily bias + DOL — the anchor rule)
    weekly_daily_bias: null,     // 'bullish' | 'bearish' | 'ranging'
    monthly_context: null,       // 'aligned' | 'conflict' | 'unclear'
    dol_identified: null,        // true | false — mandatory per DOL correction
    erl_irl_aligned: null,       // true | false | null — external/internal range liquidity confluence
    weekly_day: null,            // 'monday'|'tuesday'|'wednesday'|'thursday'|'friday'
    weekly_high_set: null,       // true | false

    // ── STAGE ── (named model + CISOD confirmation on 15M/5M)
    session: null,                // 'asian'|'london'|'newyork_am'|'lunch'|'newyork_pm'
    in_killzone: null,            // true | false
    stage_model: null,            // 'mmsm'|'mmbm'|'po3'|'liquidity_sweep'
    htf_array_present: null,      // true | false — 1H-4H/Daily PD array supporting bias
    htf_array_tf: null,           // '1h' | '4h' | 'daily' — priority reference for CISOD tf check
    cisod_displacement: null,     // true | false
    cisod_confirmation: null,     // 'fvg_cut' | 'mss' | null
    cisod_tf: null,               // '15m' | '5m' | null

    // ── ENTRY ── (execution — the easiest part, per the notes)
    entry_array_type: null,       // 'ob'|'fvg'|'mitigation'|'ote'|'iofed'
    rr_ratio: null,                // number
    target_identified: null,       // true | false
  },

  // ── DIRECTION GATE ────────────────────────────────────────
  evaluateDirection() {
    const s = this.state;
    const biasSet = s.weekly_daily_bias && s.weekly_daily_bias !== 'ranging';
    const monthlyOk = s.monthly_context === 'aligned' || s.monthly_context === null;
    const monthlyConflict = s.monthly_context === 'conflict';
    const dolOk = s.dol_identified === true;

    const pass = biasSet && dolOk && !monthlyConflict;

    let detail;
    if (!biasSet) detail = 'No Weekly/Daily bias established — this is where analysis must start. Anything below the 4H is only for entry, never for forming bias.';
    else if (!dolOk) detail = 'Bias is set, but no Draw on Liquidity identified. DOL is a MANDATORY prerequisite — "there should be a bigger focus on DOL" before anything else is framed.';
    else if (monthlyConflict) detail = 'Monthly context conflicts with your Weekly/Daily bias — never trade against the monthly structure, even if the lower-timeframe setup looks perfect.';
    else detail = `${s.weekly_daily_bias.toUpperCase()} bias confirmed on Weekly/Daily with a clear DOL identified${s.erl_irl_aligned ? ' — external/internal range liquidity aligned (directional confluence)' : ''}.`;

    return {
      pass, label: 'Direction',
      detail,
      score: pass ? (s.erl_irl_aligned ? 30 : 24) : (biasSet && dolOk ? 15 : 0),
      max: 30,
    };
  },

  // ── STAGE GATE ────────────────────────────────────────────
  // Only meaningful once Direction has passed — this is the core
  // gating behavior: Stage is LOCKED until Direction confirms.
  evaluateStage(directionPassed) {
    const s = this.state;
    if (!directionPassed) {
      return { pass: false, locked: true, label: 'Stage', score: 0, max: 45,
        detail: 'Locked — Direction must pass first. Stage only has meaning once you know where price is going.' };
    }

    const modelSet = !!s.stage_model;
    const arrayOk = s.htf_array_present === true;
    const displacementOk = s.cisod_displacement === true;
    const cisodConfirmed = !!s.cisod_confirmation;

    // Priority rule: 4H/Daily array → prefer 15M CISOD. 1H array → 5M sufficient.
    let tfPriorityOk = true;
    let tfNote = '';
    if (arrayOk && s.cisod_tf) {
      if ((s.htf_array_tf === '4h' || s.htf_array_tf === 'daily') && s.cisod_tf !== '15m') {
        tfPriorityOk = false;
        tfNote = ' Note: with a 4H/Daily array, the 15M CISOD is the priority reference — a 5M-only confirmation here is weaker.';
      }
    }

    const cisodValid = displacementOk && cisodConfirmed;
    const pass = modelSet && arrayOk && cisodValid;

    let detail;
    if (!modelSet) detail = 'No Stage model identified. Stage is your market model — MMSM/MMBM, PO3, or a liquidity sweep. No stage = no trade.';
    else if (!arrayOk) detail = `${s.stage_model.toUpperCase()} model selected, but no HTF PD Array (1H-4H/Daily) supporting the bias has been confirmed yet.`;
    else if (!cisodValid) detail = 'HTF array present, but no valid CISOD (Change In State Of Delivery) — requires displacement PLUS either an FVG cut or MSS on the 15M/5M.';
    else detail = `${s.stage_model.toUpperCase()} confirmed via CISOD (${s.cisod_confirmation === 'fvg_cut' ? 'FVG cut' : 'MSS'} on ${s.cisod_tf ? s.cisod_tf.toUpperCase() : 'LTF'}).${tfNote}`;

    return {
      pass, locked: false, label: 'Stage',
      detail,
      score: pass ? (tfPriorityOk ? 45 : 35) : (modelSet && arrayOk ? 15 : 0),
      max: 45,
    };
  },

  // ── ENTRY GATE ────────────────────────────────────────────
  // Only meaningful once Stage has passed. Deliberately the
  // smallest weight of the three — the notes are explicit that
  // entry is "the easiest part" and most over-focused-on step.
  evaluateEntry(stagePassed) {
    const s = this.state;
    if (!stagePassed) {
      return { pass: false, locked: true, label: 'Entry', score: 0, max: 25,
        detail: 'Locked — Stage must confirm first. The entry array only matters once the Stage has validated the move.' };
    }

    const arrayTypeSet = !!s.entry_array_type;
    const rr = parseFloat(s.rr_ratio) || 0;
    const rrOk = rr >= 2;
    const targetOk = s.target_identified === true;

    const pass = arrayTypeSet && rrOk && targetOk;

    let detail;
    if (!arrayTypeSet) detail = 'No entry array selected — OB, FVG, Mitigation Block, OTE, or IOFED.';
    else if (!targetOk) detail = 'Entry array selected, but no clear liquidity target identified for the trade.';
    else if (!rrOk) detail = `${rr > 0 ? rr + ':1' : 'No'} R:R — minimum 2:1 required. Below this, skip the trade regardless of how clean the array looks.`;
    else detail = `${this._arrayLabel(s.entry_array_type)} entry at ${rr}:1 R:R with a clear target — execution confirmed.`;

    return {
      pass, locked: false, label: 'Entry',
      detail,
      score: pass ? (rr >= 3 ? 25 : 20) : (arrayTypeSet && targetOk ? 10 : 0),
      max: 25,
    };
  },

  _arrayLabel(type) {
    const map = { ob: 'Order Block', fvg: 'FVG', mitigation: 'Mitigation Block', ote: 'OTE', iofed: 'IOFED' };
    return map[type] || type;
  },

  // ── FULL SEQUENTIAL EVALUATION ────────────────────────────
  evaluateGates() {
    const direction = this.evaluateDirection();
    const stage = this.evaluateStage(direction.pass);
    const entry = this.evaluateEntry(stage.pass);

    const gates = { direction, stage, entry };
    const total = direction.score + stage.score + entry.score;
    const tier = SMC_DATA.score_tiers.find(t => total >= t.min && total <= t.max) || SMC_DATA.score_tiers[3];

    const s = this.state;
    const direction_label = entry.pass
      ? (s.weekly_daily_bias === 'bullish' ? 'LONG' : 'SHORT')
      : direction.pass
        ? (s.weekly_daily_bias === 'bullish' ? 'LONG BIAS' : 'SHORT BIAS')
        : 'NEUTRAL';

    // ── WEEKLY BIAS WARNING ───────────────────────────────
    let weekly_warning = null;
    if (s.weekly_day && s.weekly_high_set !== null) {
      const bias = s.weekly_daily_bias;
      const day = s.weekly_day;
      const highSet = s.weekly_high_set;
      if (bias === 'bearish' && !highSet && (day === 'wednesday' || day === 'thursday' || day === 'friday')) {
        weekly_warning = 'Weekly high not yet set — probability decreasing as week progresses for bearish bias';
      } else if (bias === 'bullish' && !highSet && (day === 'wednesday' || day === 'thursday' || day === 'friday')) {
        weekly_warning = 'Weekly low not yet set — probability decreasing as week progresses for bullish bias';
      } else if ((bias === 'bearish' || bias === 'bullish') && !highSet && (day === 'monday' || day === 'tuesday')) {
        weekly_warning = 'High probability zone — the weekly high/low is statistically likely to form Monday or Tuesday (~80% combined)';
      }
    }

    let dol_warning = null;
    if (s.dol_identified === false || (s.weekly_daily_bias && s.dol_identified === null)) {
      dol_warning = 'Reminder: identify the Draw on Liquidity BEFORE framing any PD Array. This is step one in every trade, without exception.';
    }

    return { gates, total, tier, direction: direction_label, weekly_warning, dol_warning };
  },

  // ── RESET ─────────────────────────────────────────────────
  reset() {
    Object.keys(this.state).forEach(k => { this.state[k] = null; });
  },

  // ── SET FIELD ─────────────────────────────────────────────
  set(field, value) {
    this.state[field] = value;
  },
};