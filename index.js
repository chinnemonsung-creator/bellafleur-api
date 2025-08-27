/**
 * Bellafleur-Benly Production API
 * Endpoints: /start-auth, /status, /dlt/callback, /renew-link, /config
 * Security: CORS allowlist, Helmet, Rate limit, Idempotency-Key
 * Storage: In-memory Map (แนะนำเปลี่ยนเป็น Redis เมื่อขึ้นจริง)
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

// แทนที่ 1 บรรทัดเดิม ด้วย 2 บรรทัดนี้ (รองรับ express-rate-limit v6/v7)
const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib.default || rateLimitLib;

const crypto = require('crypto');

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const LINK_TTL_SEC = parseInt(process.env.LINK_TTL_SEC || '180', 10);       // 3 นาที
const SESSION_TTL_SEC = parseInt(process.env.SESSION_TTL_SEC || '1800', 10); // 30 นาที

// ใส่ LIFF ID ใน Environment Variables
const LIFF_ID = process.env.LIFF_ID || ''; // เช่น "2007996035-kv9ZRMNL"

// CORS allowlist
const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const app = express();
app.set('trust proxy', 1); // ถ้ามี reverse proxy / CDN
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(express.json({ limit: '200kb' }));

// CORS: allow เฉพาะโดเมน frontend ของคุณ
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // อนุญาต curl / health
    const ok = ALLOWED.includes(origin);
    cb(ok ? null : new Error('CORS not allowed'), ok);
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Idempotency-Key'],
  maxAge: 600
}));

// ---------- Rate limits ----------
const limiterCommon = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
const limiterStartRenew = rateLimit({
  windowMs: 60_000,
  max: 60
});
const limiterStatus = rateLimit({
  windowMs: 60_000,
  max: 300
});
const limiterCallback = rateLimit({
  windowMs: 60_000,
  max: 120
});
app.use(limiterCommon);

// ---------- In-memory store ----------
/**
 * sessions: Map<sid, {
 *   sid, status, step, txID, deep_link, issued_at, expires_at,
 *   attempt_no, last_seen, progress, result, history:[],
 *   last_client_info?: {}, idempotency: Map<idempotencyKey, {payload, ts}>, timers:{}
 * }>
 */
const sessions = new Map();

// ---------- Helpers ----------
const now = () => Date.now();
const uuid = () => crypto.randomUUID();
const genTxID = () => uuid();
const newDeepLink = (txID) =>
  // NOTE: โปรดเรียก service จริงเพื่อ "ออก" deep_link/txID แทนการ gen เอง
  `https://imauth.bora.dopa.go.th/oauth2/?version=2&txID=${txID}&qrcode=AUTHEN-${txID}#/`;

const calcStep = (status) => (
  status === 'SUCCESS' ? 3 :
  (['AUTHING','AUTHED','BOOKING'].includes(status) ? 2 : 1)
);

function ensureSession(sid) {
  if (!sessions.has(sid)) {
    sessions.set(sid, {
      sid,
      status: 'WAITING',
      step: 1,
      attempt_no: 0,
      last_seen: now(),
      history: [],
      idempotency: new Map(),
      timers: {}
    });
  }
  return sessions.get(sid);
}
function markSeen(s) { s.last_seen = now(); }
function maskLink(link) {
  if (!link) return '';
  try {
    const url = new URL(link);
    const tx = url.searchParams.get('txID');
    if (tx && tx.length > 8) {
      return link.replace(tx, tx.slice(0,4) + '…' + tx.slice(-4));
    }
  } catch(_) {}
  return link;
}
function randomPlate() {
  const letters = 'กขคงจฉชซญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮ'.split('');
  const pick = () => letters[Math.floor(Math.random() * letters.length)];
  return `${pick()}${pick()}${Math.floor(Math.random() * 9000 + 1000)}`;
}
function clearTimers(s) {
  if (s.timers?.progress) clearInterval(s.timers.progress);
  if (s.timers?.success)  clearTimeout(s.timers.success);
  s.timers = {};
}

// --- UA helpers เพื่อชี้นำฝั่งหน้าเว็บว่าจะเปิด ThaiID อย่างไร ---
function isLineUA(ua = '') {
  return /Line\//i.test(ua) || /LIFF|linemyapp/i.test(ua);
}
function isIOSUA(ua = '') {
  return /(iPhone|iPad|iPod|CriOS|FxiOS)/i.test(ua);
}
function pickOpenStrategy(ua = '') {
  // ถ้าอยู่ใน LINE และมี LIFF_ID → แนะนำเปิดแบบ liff_external
  if (isLineUA(ua) && LIFF_ID) return 'liff_external';
  // นอก LINE: เปิดเป็นแท็บใหม่ (กันทับหน้า verify)
  return 'new_tab';
}
function buildOpenHint(ua = '') {
  return {
    in_line: isLineUA(ua),
    is_ios: isIOSUA(ua),
    open_strategy: pickOpenStrategy(ua), // 'liff_external' | 'new_tab'
    liff_id: LIFF_ID || null
  };
}

// จำลอง booking หลัง callback (AHK จะทำจริงในโปรดักชัน)
function simulateBooking(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  clearTimers(s);
  s.status = 'BOOKING';
  s.step   = 2;
  s.progress = { phase: 'fill_form', percent: 8 };
  s.history.push({ ts: now(), ev: 'BOOKING_START' });

  s.timers.progress = setInterval(() => {
    const ss = sessions.get(sid);
    if (!ss || ss.status !== 'BOOKING') return clearInterval(s?.timers?.progress);
    ss.progress.percent += Math.floor(10 + Math.random() * 15);
    if (ss.progress.percent >= 100) {
      ss.progress.percent = 100;
      clearInterval(ss.timers.progress);
      ss.status = 'SUCCESS';
      ss.step   = 3;
      ss.result = {
        ticket_no: `DLT-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(Math.floor(Math.random()*1000)).padStart(3,'0')}`,
        plate: randomPlate()
      };
      ss.history.push({ ts: now(), ev: 'SUCCESS', result: ss.result });
    }
  }, 1200);
}

// ล้าง session เก่าลดหน่วยความจำ
setInterval(() => {
  const cutoff = now() - (SESSION_TTL_SEC * 1000);
  for (const [sid, s] of sessions.entries()) {
    if (s.last_seen < cutoff) {
      clearTimers(s);
      sessions.delete(sid);
    }
  }
}, 60_000);

// ---------- Middlewares ----------
function requireJson(req, res, next) {
  if ((req.method === 'POST' || req.method === 'PUT') &&
      !req.is('application/json')) {
    return res.status(415).json({ ok:false, error:'UNSUPPORTED_MEDIA', message:'Content-Type must be application/json' });
  }
  next();
}
app.use(requireJson);

// ---------- (ใหม่) GET /config ----------
// ให้หน้าเว็บรู้ liff_id และ hint ตาม UA ปัจจุบัน
app.get('/config', (req, res) => {
  const ua = req.get('User-Agent') || '';
  return res.json({
    ok: true,
    liff_id: LIFF_ID || null,
    hint: buildOpenHint(ua)
  });
});

// ---------- 1) POST /start-auth ----------
app.post('/start-auth', limiterStartRenew, (req, res) => {
  try {
    const { sid, click_token, attempt_no, channel, client_info } = req.body || {};
    const idemKey = req.get('Idempotency-Key') || click_token || '';
    if (!sid) return res.status(400).json({ ok:false, error:'INVALID_SID', message:'sid required' });

    const s = ensureSession(sid);
    markSeen(s);

    // Idempotency per sid (กันดับเบิลคลิก/รีเพลย์)
    if (idemKey) {
      const cache = s.idempotency.get(idemKey);
      if (cache && (now() - cache.ts < 5 * 60_000)) {
        return res.json(cache.payload); // คืน response เดิม
      }
    }

    // เก็บ client_info ล่าสุดไว้ใน session (ช่วยตอน renew-link)
    s.last_client_info = client_info || { ua: req.get('User-Agent') || '' };

    // TODO: เรียก service จริงเพื่อออก deep_link/txID
    s.attempt_no = attempt_no || (s.attempt_no + 1);
    s.status = 'AUTHING';
    s.step   = 2;
    s.txID = genTxID();
    s.issued_at = now();
    s.expires_at = s.issued_at + (LINK_TTL_SEC * 1000);
    s.deep_link = newDeepLink(s.txID);
    const hint = buildOpenHint((client_info && client_info.ua) || req.get('User-Agent') || '');
    s.history.push({ ts: now(), ev:'START_AUTH', channel, client_info, click_token, idemKey, hint });

    const payload = {
      ok: true,
      sid,
      status: s.status,
      step: s.step,
      hint, // <<<< ให้หน้าเว็บใช้ตัดสินใจว่าจะเปิดด้วย LIFF external
      auth: {
        txID: s.txID,
        deep_link: s.deep_link,
        expires_in: Math.max(0, Math.ceil((s.expires_at - now()) / 1000)),
        issued_at: Math.floor(s.issued_at / 1000)
      }
    };

    if (idemKey) s.idempotency.set(idemKey, { payload, ts: now() });
    return res.json(payload);

  } catch (e) {
    return res.status(500).json({ ok:false, error:'INTERNAL', message:e.message });
  }
});

// ---------- 2) GET /status?sid=... ----------
app.get('/status', limiterStatus, (req, res) => {
  try {
    const { sid } = req.query;
    const s = sessions.get(sid);
    if (!s) return res.json({ ok:false, error:'INVALID_SID', message:'unknown sid' });
    markSeen(s);

    // หมดอายุลิงก์ระหว่าง AUTHING
    if (s.status === 'AUTHING' && now() > s.expires_at) {
      s.status = 'EXPIRED';
      s.history.push({ ts: now(), ev: 'LINK_EXPIRED' });
    }
    s.step = calcStep(s.status);

    const payload = { ok:true, sid, status: s.status, step: s.step };
    if (s.status === 'AUTHING') {
      payload.ttl = Math.max(0, Math.ceil((s.expires_at - now()) / 1000));
    }
    if (s.status === 'BOOKING' && s.progress) {
      payload.progress = s.progress;
    }
    if (s.status === 'SUCCESS' && s.result) {
      payload.result = s.result;
    }
    if (s.status === 'EXPIRED') {
      payload.error = 'LINK_EXPIRED';
    }
    return res.json(payload);

  } catch (e) {
    return res.status(500).json({ ok:false, error:'INTERNAL', message:e.message });
  }
});

// ---------- 3) POST /dlt/callback ----------
app.post('/dlt/callback', limiterCallback, (req, res) => {
  try {
    const { sid, txID, event, dlt } = req.body || {};
    if (!sid) return res.status(400).json({ ok:false, error:'INVALID_SID', message:'sid required' });
    const s = sessions.get(sid);
    if (!s) return res.status(404).json({ ok:false, error:'NOT_FOUND', message:'unknown sid' });

    markSeen(s);

    // ตรวจ txID ให้ตรงกับ session กันสลับ/ยิงมั่ว
    if (txID && s.txID && txID !== s.txID) {
      s.history.push({ ts: now(), ev:'TX_MISMATCH', got:txID, expect:s.txID });
      return res.status(409).json({ ok:false, error:'TX_MISMATCH', message:'txID mismatch' });
    }

    s.status = 'AUTHED';
    s.step   = 2;
    s.history.push({ ts: now(), ev:'DLT_CALLBACK', event, dlt });

    // โปรดเอา simulateBooking ออก แล้วให้ AHK เป็นคน /status=BOOKING → SUCCESS เองในระบบจริง
    simulateBooking(sid);

    return res.json({ ok:true, sid, status: s.status });

  } catch (e) {
    return res.status(500).json({ ok:false, error:'INTERNAL', message:e.message });
  }
});

// ---------- 4) POST /renew-link ----------
app.post('/renew-link', limiterStartRenew, (req, res) => {
  try {
    const { sid } = req.body || {};
    if (!sid) return res.status(400).json({ ok:false, error:'INVALID_SID', message:'sid required' });

    const s = sessions.get(sid);
    if (!s) return res.status(404).json({ ok:false, error:'NOT_FOUND', message:'unknown sid' });
    markSeen(s);

    if (!['WAITING','AUTHING','EXPIRED','ERROR'].includes(s.status)) {
      return res.status(400).json({ ok:false, error:'CANNOT_RENEW', message:'cannot renew in current status' });
    }

    s.status = 'AUTHING';
    s.step   = 2;
    s.txID = genTxID();
    s.issued_at = now();
    s.expires_at = s.issued_at + (LINK_TTL_SEC * 1000);
    s.deep_link = newDeepLink(s.txID);
    clearTimers(s);

    // ใช้ UA ล่าสุดที่รู้จัก (หรือ header ปัจจุบัน) เพื่อคำนวณ hint
    const ua = (s.last_client_info && s.last_client_info.ua) || req.get('User-Agent') || '';
    const hint = buildOpenHint(ua);

    s.history.push({ ts: now(), ev:'RENEW_LINK', hint });

    return res.json({
      ok: true,
      sid,
      status: s.status,
      step: s.step,
      hint, // <<<< ส่ง hint ให้ด้วย
      auth: {
        txID: s.txID,
        deep_link: s.deep_link,
        expires_in: Math.max(0, Math.ceil((s.expires_at - now()) / 1000)),
        issued_at: Math.floor(s.issued_at / 1000)
      }
    });

  } catch (e) {
    return res.status(500).json({ ok:false, error:'INTERNAL', message:e.message });
  }
});

// ---------- Optional: DEV routes (ปิดใน production) ----------
if (NODE_ENV !== 'production') {
  app.get('/sessions', (req, res) => {
    const list = [];
    for (const [sid, s] of sessions.entries()) {
      list.push({
        sid,
        status: s.status,
        step: s.step,
        txID: s.txID,
        deep_link: maskLink(s.deep_link),
        expires_in: s.expires_at ? Math.max(0, Math.ceil((s.expires_at - now())/1000)) : null,
        attempt_no: s.attempt_no,
        last_seen: s.last_seen
      });
    }
    res.json({ ok:true, count:list.length, sessions:list });
  });
  app.get('/sessions/:sid', (req, res) => {
    const s = sessions.get(req.params.sid);
    if (!s) return res.status(404).json({ ok:false, error:'NOT_FOUND' });
    res.json({ ok:true, session: { ...s, deep_link: maskLink(s.deep_link) }});
  });
  app.delete('/sessions/:sid', (req, res) => {
    const s = sessions.get(req.params.sid);
    if (!s) return res.status(404).json({ ok:false, error:'NOT_FOUND' });
    clearTimers(s); sessions.delete(req.params.sid);
    res.json({ ok:true, deleted:req.params.sid });
  });
}

// ---------- Health ----------
app.get('/', (req, res) => res.send('Bellafleur-Benly API is up'));

// ---------- Error handler ----------
app.use((err, req, res, next) => {
  if (err && /CORS/.test(err.message)) {
    return res.status(403).json({ ok:false, error:'CORS', message:'Origin not allowed' });
  }
  return res.status(500).json({ ok:false, error:'INTERNAL', message: err?.message || 'internal error' });
});


// เดิม:
// app.listen(PORT, () => { ... });

// ใหม่:
const server = app.listen(PORT, () => {
  console.log(`API listening on http://0.0.0.0:${PORT} (env=${NODE_ENV})`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));