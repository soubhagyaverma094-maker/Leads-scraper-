'use strict';

/* ============================================================
   DATABASE  (Upstash Redis over REST - no packages needed)
   ============================================================ */
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(...args) {
  if (!RURL || !RTOKEN) throw new Error('Database not connected. In Vercel: Storage tab > add Upstash Redis.');
  const r = await fetch(RURL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RTOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const j = await r.json();
  if (j.error) throw new Error('Redis: ' + j.error);
  return j.result;
}

const parse = (v) => { try { return JSON.parse(v); } catch (e) { return v; } };
async function hgetall(key) {
  const a = (await redis('HGETALL', key)) || [];
  const o = {};
  for (let i = 0; i < a.length; i += 2) o[a[i]] = parse(a[i + 1]);
  return o;
}
const hset = (key, field, val) => redis('HSET', key, field, JSON.stringify(val));
async function hget(key, field) { const v = await redis('HGET', key, field); return v ? parse(v) : null; }
async function get(key) { const v = await redis('GET', key); return v ? parse(v) : null; }
const set = (key, val) => redis('SET', key, JSON.stringify(val));

/* ============================================================
   AUTH
   ============================================================ */
function authed(req) {
  const p = process.env.DASHBOARD_PASSWORD;
  return !!p && req.headers['x-auth'] === p;
}

/* ============================================================
   SETTINGS
   ============================================================ */
const DEFAULT_SETTINGS = {
  perDay: 100,
  cities: ['Raipur', 'Nagpur', 'Indore', 'Bhopal', 'Jaipur', 'Pune', 'Ahmedabad', 'Lucknow', 'Surat', 'Mumbai', 'Delhi', 'Bengaluru'],
  // Job titles to search on Indeed / Naukri / LinkedIn. A business hiring for these roles is a lead.
  terms: [
    'digital marketing executive', 'social media manager', 'social media executive', 'SEO executive',
    'performance marketing executive', 'content writer', 'graphic designer', 'marketing executive',
  ],
};
async function getSettings() { return { ...DEFAULT_SETTINGS, ...((await get('settings')) || {}) }; }
async function saveSettings(b) {
  const list = (x) => (Array.isArray(x) ? x : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 100);
  const cur = await getSettings();
  const next = {
    perDay: Math.min(300, Math.max(1, parseInt(b.perDay, 10) || cur.perDay)),
    cities: list(b.cities).length ? list(b.cities) : cur.cities,
    terms: list(b.terms).length ? list(b.terms) : cur.terms,
  };
  await set('settings', next);
  return next;
}

/* ============================================================
   LEAD SOURCE
   1. A GitHub Action (scripts/scrape.py, python-jobspy) finds businesses
      that are hiring marketing / design / content staff on Indeed, Naukri
      and LinkedIn. Those businesses are the leads.
   2. The Action sends them in small batches to /api/ingest.
   3. Here we filter agencies, then use Google Places ONLY to find the
      phone number (and website) of each business.
   ============================================================ */
const BAD_NAME = /\b(digital|marketing|seo|advertis\w*|agency|agencies|web\s?(design\w*|develop\w*|solutions?)|website\w*|software|info\s?tech|infotech|it\s?(solutions?|services?)|technolog\w*|technologies|tech|media|branding|creatives?|app\s?develop\w*)\b/i;
const BAD_STAFF = /\b(staffing|recruit\w*|placements?|manpower|consultanc\w*|consultants?|hr\s?solutions?|talent|headhunt\w*|outsourc\w*|job\s?portal)\b/i;
const BAD_HOST = /(digital|marketing|seo|agency|webdesign|webdev|infotech|technolog|softwar)/i;
const BAD_TYPES = ['advertising_agency', 'marketing_agency', 'software_company', 'employment_agency'];

function isAgency(p, name) {
  if (BAD_NAME.test(name) || BAD_STAFF.test(name)) return true;
  if (p) {
    if ((p.types || []).some((t) => BAD_TYPES.includes(t)) || BAD_TYPES.includes(p.primaryType)) return true;
    if (p.websiteUri) {
      try { if (BAD_HOST.test(new URL(p.websiteUri).hostname)) return true; } catch (e) { /* ignore */ }
    }
  }
  return false;
}

function normPhone(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) { s = s.replace(/^0+/, ''); s = (process.env.DEFAULT_COUNTRY_CODE || '+91') + s; }
  return /^\+\d{8,15}$/.test(s) ? s : null;
}

const slug = (x) => String(x || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const STOP = new Set(['pvt', 'ltd', 'private', 'limited', 'llp', 'inc', 'the', 'and', 'india', 'co', 'company', 'corp', 'group']);
const tokens = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t));

// Is the Google place really the same business as the company in the job post?
function sameBusiness(company, placeName) {
  const a = tokens(company), b = new Set(tokens(placeName));
  if (!a.length || !b.size) return false;
  const hit = a.filter((t) => b.has(t)).length;
  return hit >= Math.ceil(a.length / 2);
}

const PHONE_FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.internationalPhoneNumber',
  'places.nationalPhoneNumber', 'places.websiteUri', 'places.types', 'places.primaryType', 'places.businessStatus',
].join(',');

// Google Places is used only here: company name + city -> phone number.
async function findPhone(company, city) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('GOOGLE_PLACES_API_KEY is missing');
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': PHONE_FIELDS },
    body: JSON.stringify({ textQuery: company + ' ' + city, pageSize: 3, regionCode: process.env.PLACES_REGION || 'IN' }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Google Places error');
  for (const p of j.places || []) {
    const nm = (p.displayName && p.displayName.text) || '';
    if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') continue;
    if (!sameBusiness(company, nm)) continue;
    const phone = normPhone(p.internationalPhoneNumber || p.nationalPhoneNumber);
    if (phone) return { place: p, phone, placeName: nm };
  }
  return null;
}

async function ingest(body) {
  const items = (Array.isArray(body.leads) ? body.leads : []).slice(0, 40);
  const runId = String(body.runId || 'run_' + new Date().toISOString().slice(0, 10));
  const s = await getSettings();

  let st = await get('lastFetch');
  if (!st || st.runId !== runId) st = { runId, added: 0, skippedAgencies: 0, noPhone: 0, duplicates: 0 };
  st.skippedAgencies += Number(body.preFiltered) || 0;

  const existing = Object.values(await hgetall('leads'));
  const seenIds = new Set(existing.map((l) => l.id));
  const seenPhones = new Set(existing.map((l) => l.phone));
  const fresh = [];

  for (let i = 0; i < items.length && st.added + fresh.length < s.perDay; i += 5) {
    const chunk = items.slice(i, i + 5);
    const out = await Promise.all(chunk.map(async (it) => {
      const name = String(it.name || '').trim().slice(0, 120);
      const city = String(it.city || '').trim().slice(0, 80);
      if (!name) return { skip: 'bad' };
      const id = 'j_' + slug(name);
      if (seenIds.has(id)) return { skip: 'dup' };
      if (isAgency(null, name)) return { skip: 'agency' };
      if (await redis('EXISTS', 'np:' + id)) return { skip: 'nophone' };
      let found = null;
      try { found = await findPhone(name, city); } catch (e) { return { skip: 'error', error: e.message }; }
      if (!found) { await redis('SET', 'np:' + id, '1', 'EX', 60 * 60 * 24 * 30); return { skip: 'nophone' }; }
      if (isAgency(found.place, name)) { await redis('SET', 'np:' + id, '1', 'EX', 60 * 60 * 24 * 30); return { skip: 'agency' }; }
      return { id, name, city, found, it };
    }));

    for (const o of out) {
      if (o.skip === 'dup') st.duplicates++;
      else if (o.skip === 'agency') st.skippedAgencies++;
      else if (o.skip === 'nophone') st.noPhone++;
      else if (o.skip === 'error') { st.lastError = o.error; }
      else if (o.id) {
        if (seenIds.has(o.id) || seenPhones.has(o.found.phone)) { st.duplicates++; continue; }
        if (st.added + fresh.length >= s.perDay) continue;
        const p = o.found.place;
        fresh.push({
          id: o.id, name: o.name, phone: o.found.phone, city: o.city,
          category: String(o.it.jobTitle || 'Hiring for marketing').slice(0, 120),
          jobTitle: String(o.it.jobTitle || '').slice(0, 120),
          source: String(o.it.source || '').slice(0, 30),
          jobUrl: String(o.it.jobUrl || '').slice(0, 500),
          email: String(o.it.email || '').slice(0, 120),
          address: p.formattedAddress || '', website: p.websiteUri || '',
          status: 'new', createdAt: Date.now(),
        });
        seenIds.add(o.id); seenPhones.add(o.found.phone);
      }
    }
  }

  if (fresh.length) {
    const flat = [];
    for (const l of fresh) flat.push(l.id, JSON.stringify(l));
    await redis('HSET', 'leads', ...flat);
  }
  st.added += fresh.length;
  st.at = Date.now();
  await set('lastFetch', st);
  return { ...st, addedNow: fresh.length, perDay: s.perDay, full: st.added >= s.perDay };
}

// Dashboard button: ask GitHub to run the scraper workflow now.
async function triggerScrape() {
  const repo = process.env.GH_REPO, token = process.env.GH_TOKEN;
  if (!repo || !token) throw new Error('Set GH_REPO and GH_TOKEN in Vercel to use this button. The daily run works without them.');
  const r = await fetch('https://api.github.com/repos/' + repo + '/actions/workflows/daily-leads.yml/dispatches', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'leaddesk',
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: process.env.GH_BRANCH || 'main' }),
  });
  if (r.status !== 204) {
    const j = await r.json().catch(() => ({}));
    throw new Error('GitHub: ' + (j.message || r.status));
  }
  return { started: true };
}

/* ============================================================
   VOICE PROVIDER
   To use Rasen instead of Vapi: fill in the 'rasen' branches below.
   startCall must return { id }. parseWebhook must return the
   normalized object shown in the vapi branch.
   ============================================================ */
const PROVIDER = () => (process.env.VOICE_PROVIDER || 'vapi').toLowerCase();

async function startCall({ number, name, jobTitle }) {
  if (PROVIDER() === 'vapi') {
    const r = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.VAPI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assistantId: process.env.VAPI_ASSISTANT_ID,
        phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
        customer: { number, name: name || undefined },
        assistantOverrides: { variableValues: { leadName: name || 'there', jobTitle: jobTitle || 'a marketing role' } },
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error('Voice provider: ' + (Array.isArray(j.message) ? j.message.join(', ') : j.message || r.status));
    return { id: j.id };
  }
  if (PROVIDER() === 'rasen') {
    // Configurable so you can paste the exact URL/body from Rasen's docs into Vercel env vars.
    const url = process.env.RASEN_CALL_URL;
    if (!url) throw new Error('Set RASEN_CALL_URL (the place-call address from Rasen docs) in Vercel.');
    const fill = (str, vals) => str.replace(/\{\{(\w+)\}\}/g, (m, k) => JSON.stringify(String(vals[k] == null ? '' : vals[k])).slice(1, -1));
    const vals = {
      phone: number, name: name || 'there', jobTitle: jobTitle || 'a marketing role',
      agentId: process.env.RASEN_AGENT_ID || '', callerId: process.env.RASEN_PHONE_NUMBER_ID || '',
    };
    const template = process.env.RASEN_CALL_BODY ||
      '{"agent_id":"{{agentId}}","to_number":"{{phone}}","variables":{"leadName":"{{name}}","jobTitle":"{{jobTitle}}"}}';
    let payload;
    try { payload = fill(template, vals); JSON.parse(payload); } catch (e) { throw new Error('RASEN_CALL_BODY is not valid JSON'); }
    const headers = { 'Content-Type': 'application/json' };
    const hname = process.env.RASEN_AUTH_HEADER || 'Authorization';
    headers[hname] = hname.toLowerCase() === 'authorization' ? 'Bearer ' + process.env.RASEN_API_KEY : process.env.RASEN_API_KEY;
    const r = await fetch(url, { method: 'POST', headers, body: payload });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Rasen: ' + String((j && (j.message || j.error || j.detail)) || r.status).slice(0, 150));
    const d = j.data || j.call || j;
    const id = d.call_id || d.callId || d.id || d.session_id || d.conversation_id;
    if (!id) throw new Error('Rasen did not return a call id. Response: ' + JSON.stringify(j).slice(0, 150));
    return { id: String(id) };
  }
  throw new Error('Unknown VOICE_PROVIDER');
}

function parseWebhook(body) {
  if (PROVIDER() === 'vapi') {
    const m = (body && body.message) || {};
    if (m.type !== 'end-of-call-report') return null;
    const a = m.artifact || {};
    let dur = Number(m.durationSeconds);
    if (!dur && m.startedAt && m.endedAt) dur = (new Date(m.endedAt) - new Date(m.startedAt)) / 1000;
    return {
      callId: m.call && m.call.id,
      endedReason: m.endedReason || (m.call && m.call.endedReason) || '',
      durationSec: Math.round(dur || 0),
      recordingUrl: m.recordingUrl || a.recordingUrl || '',
      transcript: m.transcript || a.transcript || '',
      startedAt: m.startedAt || null,
      customerNumber: (m.customer && m.customer.number) || (m.call && m.call.customer && m.call.customer.number) || '',
    };
  }
  if (PROVIDER() === 'rasen') {
    const b = body || {};
    const d = b.data || b.call || b.payload || b;
    const pick = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return ''; };
    const event = String(b.event || b.type || d.event || '').toLowerCase();
    let tr = pick(d, ['transcript', 'transcription', 'messages', 'conversation']);
    if (Array.isArray(tr)) {
      tr = tr.map((m) => {
        const role = String(m.role || m.speaker || m.from || '').toLowerCase();
        const who = /user|customer|human|caller|client/.test(role) ? 'User' : 'AI';
        return who + ': ' + (m.text || m.content || m.message || '');
      }).join('\n');
    } else if (tr && typeof tr === 'object') tr = JSON.stringify(tr);
    const rec = pick(d, ['recording_url', 'recordingUrl', 'recording', 'audio_url', 'audioUrl']);
    const callId = pick(d, ['call_id', 'callId', 'id', 'session_id', 'conversation_id']) || pick(b, ['call_id', 'callId']);
    // Rasen sends call.completed first and call.analyzed later. Save once the result is complete.
    const complete = event.includes('analy') || (tr && rec);
    if (!callId || !complete) return null;
    let dur = Number(pick(d, ['duration_seconds', 'durationSeconds', 'durationSec', 'duration']));
    return {
      callId: String(callId),
      endedReason: String(pick(d, ['ended_reason', 'endedReason', 'disconnect_reason', 'status'])),
      durationSec: Math.round(dur || 0),
      recordingUrl: typeof rec === 'string' ? rec : '',
      transcript: String(tr || ''),
      startedAt: pick(d, ['started_at', 'startedAt', 'start_time']) || null,
      customerNumber: String(pick(d, ['to_number', 'toNumber', 'customer_number', 'phone', 'to'])),
    };
  }
  return null;
}

/* ============================================================
   AI CLASSIFIER  (reads the transcript of the recording)
   ============================================================ */
async function classify({ transcript, endedReason, durationSec }) {
  const spoke = /(^|\n)\s*(user|customer|human)\s*:/i.test(transcript || '');
  if (!transcript || !spoke) {
    return { temperature: 'not_picked', summary: 'Call was not answered or the person did not speak.', reason: endedReason || 'No speech from the lead', nextStep: 'Try again at a different time' };
  }
  const system = 'You grade outbound sales call outcomes for a digital marketing / website service. Calls may be in Hindi, English or Hinglish. Reply with ONLY a JSON object, no markdown.';
  const prompt =
    'Call transcript:\n' + transcript.slice(0, 12000) +
    '\n\nCall ended because: ' + endedReason + ' | duration: ' + durationSec + 's\n\n' +
    'Return JSON with keys:\n' +
    '"temperature": one of "hot" (clear interest, asked for price/meeting/proposal or agreed to next step), "warm" (some interest, needs follow-up), "cold" (not interested or dismissive), "callback" (asked to be called later), "do_not_call" (angry, asked to stop, wrong number), "other".\n' +
    '"summary": 1-2 sentences in English.\n"reason": why you chose that temperature, one sentence.\n"nextStep": a short recommended action.';
  const ok = ['hot', 'warm', 'cold', 'callback', 'do_not_call', 'other'];
  const shape = (o) => ({ temperature: ok.includes(o.temperature) ? o.temperature : 'other', summary: o.summary || '', reason: o.reason || '', nextStep: o.nextStep || '' });
  const parseJson = (text) => JSON.parse(String(text).replace(/```json|```/g, '').trim());

  try {
    // 1) Gemini: free key from aistudio.google.com
    if (process.env.GEMINI_API_KEY) {
      const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
        method: 'POST',
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 600, temperature: 0.2 },
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error((j.error && j.error.message) || 'Gemini error ' + r.status);
      const text = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0].text;
      return shape(parseJson(text || '{}'));
    }
    // 2) Anthropic (paid, optional)
    if (process.env.ANTHROPIC_API_KEY) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001', max_tokens: 400, system, messages: [{ role: 'user', content: prompt }] }),
      });
      const j = await r.json();
      return shape(parseJson((j.content && j.content[0] && j.content[0].text) || '{}'));
    }
  } catch (e) {
    return { ...keywordGrade(transcript), reason: 'AI unavailable (' + String(e.message).slice(0, 80) + '), graded by keywords.' };
  }
  // 3) No key at all: simple keyword grading
  return keywordGrade(transcript);
}

// Free fallback that needs no AI. Less accurate, but always works.
function keywordGrade(transcript) {
  const user = String(transcript || '').split('\n').filter((l) => /^\s*(user|customer|human)\s*:/i.test(l)).join(' ').toLowerCase();
  const has = (re) => re.test(user);
  let t = 'warm', reason = 'Person spoke with the assistant; no clear signal either way.', next = 'Listen to the recording and follow up';
  if (has(/(do not call|don't call|stop calling|mat karo|band karo|remove my number|wrong number)/)) { t = 'do_not_call'; reason = 'Asked to stop calls or wrong number.'; next = 'Do not call again'; }
  else if (has(/(call (me )?(back|later)|baad mein|baad me|abhi busy|later|kal call|tomorrow)/)) { t = 'callback'; reason = 'Asked to be called later.'; next = 'Call back at a better time'; }
  else if (has(/(price|cost|kitna|rate|charges|interested|send (me )?(details|proposal)|whatsapp|meeting|demo|sure|haan|yes)/) && !has(/(not interested|no thanks|nahi chahiye|zarurat nahi)/)) { t = 'hot'; reason = 'Showed interest or asked about price or next step.'; next = 'Send details on WhatsApp and book the free call'; }
  else if (has(/(not interested|no thanks|nahi chahiye|zarurat nahi|no need|nahi)/)) { t = 'cold'; reason = 'Said they are not interested.'; next = 'Try again after a few months'; }
  return { temperature: t, summary: 'Graded by keywords (no AI key set).', reason, nextStep: next };
}

/* ============================================================
   CALLING + AUTO-CALL QUEUE
   ============================================================ */
function inWindow() {
  const [a, b] = (process.env.CALL_WINDOW || '10-19').split('-').map(Number);
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: process.env.CALL_TZ || 'Asia/Kolkata' }).format(new Date())) % 24;
  return h >= a && h < b;
}

async function dialLead(lead) {
  const { id } = await startCall({ number: lead.phone, name: lead.name, jobTitle: lead.jobTitle });
  await hset('callmap', id, lead.id);
  lead.status = 'calling'; lead.lastCallId = id; lead.calledAt = Date.now(); delete lead.error;
  await hset('leads', lead.id, lead);
  return id;
}

async function callNext() {
  for (let i = 0; i < 5; i++) {
    const auto = (await get('auto')) || { running: false };
    if (!auto.running) return null;
    if (!inWindow()) { await set('auto', { running: false, note: 'Stopped: outside calling hours' }); return null; }
    const id = await redis('LPOP', 'queue');
    if (!id) { await set('auto', { running: false, note: 'Finished: every new lead has been called' }); return null; }
    const lead = await hget('leads', id);
    if (!lead || lead.status !== 'new') continue;
    try { return await dialLead(lead); } catch (e) {
      lead.status = 'error'; lead.error = String(e.message).slice(0, 200);
      await hset('leads', id, lead);
    }
  }
  return null;
}

async function startAuto() {
  if (!inWindow()) throw new Error('Outside calling hours (' + (process.env.CALL_WINDOW || '10-19') + ' ' + (process.env.CALL_TZ || 'Asia/Kolkata') + ')');
  const leads = Object.values(await hgetall('leads')).filter((l) => l.status === 'new').sort((a, b) => a.createdAt - b.createdAt);
  if (!leads.length) throw new Error('No new leads to call');
  await redis('DEL', 'queue');
  await redis('RPUSH', 'queue', ...leads.map((l) => l.id));
  await set('auto', { running: true, startedAt: Date.now(), note: 'Running' });
  await callNext();
}
const stopAuto = () => set('auto', { running: false, note: 'Stopped by you' });

/* ============================================================
   WEBHOOK  (voice provider tells us a call has ended)
   ============================================================ */
async function handleWebhook(req, res) {
  const secret = process.env.WEBHOOK_SECRET;
  if (req.method !== 'POST') return res.status(405).end();
  if (!secret || req.query.key !== secret) return res.status(401).json({ error: 'Bad key' });

  const ev = parseWebhook(req.body || {});
  if (!ev || !ev.callId) return res.status(200).json({ ignored: true });

  // idempotency: process each call once, even if the provider retries
  const first = await redis('SET', 'done:' + ev.callId, '1', 'NX', 'EX', 86400);
  if (!first) return res.status(200).json({ duplicate: true });

  const leadId = await hget('callmap', ev.callId);
  let lead = leadId ? await hget('leads', leadId) : null;
  // Calls started from inside the voice provider (e.g. a Rasen campaign): match the lead by phone number.
  if (!lead && ev.customerNumber) {
    const ph = normPhone(ev.customerNumber);
    if (ph) lead = Object.values(await hgetall('leads')).find((l) => l.phone === ph) || null;
  }
  const ai = await classify(ev);

  const call = {
    id: ev.callId, leadId: lead ? lead.id : null,
    name: lead ? lead.name : 'Unknown caller', phone: lead ? lead.phone : ev.customerNumber,
    city: lead ? lead.city : '', category: lead ? lead.category : '',
    jobTitle: lead ? lead.jobTitle || '' : '', website: lead ? lead.website || '' : '',
    email: lead ? lead.email || '' : '', source: lead ? lead.source || '' : '', address: lead ? lead.address || '' : '',
    startedAt: ev.startedAt ? new Date(ev.startedAt).getTime() : Date.now(),
    createdAt: Date.now(), durationSec: ev.durationSec, endedReason: ev.endedReason,
    recordingUrl: ev.recordingUrl, transcript: ev.transcript,
    temperature: ai.temperature, summary: ai.summary, reason: ai.reason, nextStep: ai.nextStep,
  };
  await hset('calls', ev.callId, call);

  if (lead) {
    lead.status = 'called'; lead.temperature = ai.temperature;
    await hset('leads', lead.id, lead);
  }

  const auto = await get('auto');
  if (auto && auto.running) await callNext();
  return res.status(200).json({ saved: true });
}

/* ============================================================
   API ROUTER
   ============================================================ */
async function handleApi(req, res) {
  const action = req.query.action;
  if (action === 'webhook') return handleWebhook(req, res);

  // The GitHub Action talks to us with INGEST_SECRET; everything else needs the dashboard password.
  if (action === 'ingest' || action === 'config') {
    const k = process.env.INGEST_SECRET;
    if (!k || req.headers['x-ingest-key'] !== k) return res.status(401).json({ error: 'Bad ingest key' });
    if (action === 'config') return res.json(await getSettings());
    if (req.method !== 'POST') return res.status(405).end();
    return res.json(await ingest(req.body && typeof req.body === 'object' ? req.body : {}));
  }
  if (!authed(req)) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  switch (action) {
    case 'leads': {
      const leads = Object.values(await hgetall('leads')).sort((a, b) => b.createdAt - a.createdAt);
      const auto = (await get('auto')) || { running: false };
      const queue = await redis('LLEN', 'queue');
      const lastFetch = await get('lastFetch');
      return res.json({ leads, auto, queue, lastFetch });
    }
    case 'calls': {
      const calls = Object.values(await hgetall('calls')).sort((a, b) => b.createdAt - a.createdAt);
      return res.json({ calls });
    }
    case 'fetch-leads':
      return res.json(await triggerScrape());
    case 'lead-update': {
      const lead = await hget('leads', body.id);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      if (['new', 'skipped'].includes(body.status)) { lead.status = body.status; await hset('leads', lead.id, lead); }
      return res.json({ ok: true });
    }
    case 'call': {
      let lead;
      if (body.leadId) {
        lead = await hget('leads', body.leadId);
        if (!lead) return res.status(404).json({ error: 'Lead not found' });
      } else {
        const phone = normPhone(body.number);
        if (!phone) return res.status(400).json({ error: 'Enter a valid phone number' });
        lead = { id: 'manual_' + Date.now(), name: (body.name || '').trim() || 'Manual call', phone, city: '', category: 'manual', status: 'new', createdAt: Date.now() };
      }
      await dialLead(lead);
      return res.json({ ok: true });
    }
    case 'auto': {
      if (body.op === 'start') {
        // Auto-call is locked with its own password, kept in Vercel (never in the code).
        const lock = process.env.AUTOCALL_PASSWORD;
        if (!lock) return res.status(403).json({ error: 'Auto-call is locked. Set AUTOCALL_PASSWORD in Vercel first.' });
        if (String(body.lockPassword || '') !== lock) return res.status(403).json({ error: 'Wrong auto-call password.' });
        await startAuto();
      } else if (body.op === 'stop') await stopAuto();
      return res.json({ ok: true });
    }
    case 'settings': {
      if (req.method === 'POST') return res.json(await saveSettings(body));
      return res.json(await getSettings());
    }
    default:
      return res.status(404).json({ error: 'Unknown action' });
  }
}

module.exports = { handleApi };
