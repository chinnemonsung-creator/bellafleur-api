# Bellafleur‑Benly Production API (Express)

API สำหรับระบบยืนยันตัวตน + สถานะการจอง (DLT)  
**โดเมนโปรดักชัน:** `https://api.bellafleur-benly.com` (ผูกกับบริการเดิม `bellafleur-api` บน Render)

> ข้อกำหนดสำคัญของโปรเจกต์นี้: ใช้ **บริการเดิม** บน Render เท่านั้น และ **ห้ามเปลี่ยน DNS/CNAME** เว้นแต่ได้รับการยืนยันก่อน

---

## โครงสร้างหลัก
```
index.js          # โค้ด Express
package.json      # สคริปต์และ dependencies
.node-version     # ล็อกเวอร์ชัน Node (เช่น 18)
```

## ความต้องการระบบ (Local)
- Node.js 18+ (แนะนำให้ตรงกับ `.node-version`)
- npm

## การรันแบบ Local
```bash
# ติดตั้งแพ็กเกจ
npm install

# รันเซิร์ฟเวอร์
node index.js
# จะขึ้นข้อความ: API listening on http://0.0.0.0:3000
```

## ตัวแปรสภาพแวดล้อม (ENV)
ตั้งค่าใน Render → *Settings → Environment*
```
LINK_TTL_SEC=60          # อายุลิงก์ auth (วินาที)
SESSION_TTL_SEC=1800     # อายุ session (วินาที)
LIFF_ID=<ถ้ามี>          # สำหรับเปิดผ่าน LINE LIFF (optional)
ALLOWED_ORIGINS=<ถ้ามี>  # ระบุโดเมน frontend, คั่นด้วย ,
```
> **PORT** ไม่ต้องตั้งค่า Render จะกำหนดให้เอง และโค้ดอ่านจาก `process.env.PORT` อยู่แล้ว

## การดีพลอยบน Render (ใช้บริการเดิมเท่านั้น)
1. Render → **Services → bellafleur-api**
2. **Settings → Git**: Link repository (branch `main`), เปิด **Auto‑Deploy (on push)**
3. **Build & Deploy**:  
   - Build Command: `npm install`  
   - Start Command: `npm start`
4. *(แนะนำ)* Settings → **Health Check**: Path `/`

> **ห้าม** สร้าง service ใหม่หรือเปลี่ยนโดเมน โดยไม่ยืนยันผลกระทบก่อน

---

## Endpoints หลัก

### 1) `POST /start-auth`
เริ่มกระบวนการยืนยันตัวตน

**Headers**
```
Content-Type: application/json
Idempotency-Key: <sid>   # แนะนำให้ใส่เท่ากับ sid เพื่อกันดับเบิลคลิก
```

**Body (JSON)**
```json
{ "sid": "UUID", "channel": "web", "client_info": { "ua": "..." } }
```

**Response (ตัวอย่าง)**
```json
{
  "ok": true,
  "sid": "UUID",
  "status": "AUTHING",
  "step": 2,
  "hint": { "open_strategy": "liff_external|new_tab", "liff_id": "..." },
  "auth": {
    "txID": "xxx",
    "deep_link": "https://imauth.bora.dopa.go.th/oauth2/?version=2&txID=...",
    "expires_in": 60,
    "issued_at": 1724720000
  }
}
```

---

### 2) `GET /status?sid=<sid>`
ดูสถานะปัจจุบันของ session

**Response (ตัวอย่าง)**
```json
{ "ok": true, "sid": "UUID", "status": "AUTHING", "step": 2, "ttl": 58 }
```
สถานะที่อาจพบ: `WAITING | AUTHING | AUTHTED | BOOKING | SUCCESS | EXPIRED | ERROR`  
> **หมายเหตุ:** ในโค้ดตัวอย่างจะมีการ *simulate* จาก `AUTHED → BOOKING → SUCCESS` หลังเรียก `/dlt/callback`

---

### 3) `POST /renew-link`
ต่ออายุลิงก์ยืนยันตัวตน (ออก `txID`/`deep_link` ใหม่) — ใช้ได้เฉพาะสถานะ `WAITING|AUTHING|EXPIRED|ERROR`

**Body**
```json
{ "sid": "UUID" }
```

**Response (ตัวอย่าง)**
```json
{
  "ok": true,
  "sid": "UUID",
  "status": "AUTHING",
  "step": 2,
  "auth": { "txID": "xxx-new", "deep_link": "...", "expires_in": 60, "issued_at": 1724720400 }
}
```

---

## Endpoints เสริม

### `POST /dlt/callback`
จำลอง callback จาก DLT เพื่อเดินสถานะ (ทดสอบหลังบ้าน)
```json
{ "sid": "UUID", "txID": "ล่าสุดจาก start/renew", "event": "AUTH_SUCCESS" }
```

### `GET /config`
คืนค่า `liff_id` และคำแนะนำการเปิดลิงก์ตาม User‑Agent
```json
{ "ok": true, "liff_id": "....", "hint": { "open_strategy": "liff_external|new_tab", ... } }
```

---

## Quick Test (PowerShell)
```powershell
# เริ่ม auth
$sid = [guid]::NewGuid().ToString()
$h = @{ 'Idempotency-Key' = $sid }
$start = Invoke-RestMethod -Method POST -Uri https://api.bellafleur-benly.com/start-auth -ContentType 'application/json' -Headers $h -Body (@{ sid=$sid } | ConvertTo-Json)

# จำลอง callback → สถานะจะไหล BOOKING → SUCCESS
Invoke-RestMethod -Method POST -Uri https://api.bellafleur-benly.com/dlt/callback -ContentType 'application/json' -Body (@{ sid=$sid; txID=$start.auth.txID; event='AUTH_SUCCESS' } | ConvertTo-Json)

# เช็คผลลัพธ์
Invoke-RestMethod -Method GET -Uri "https://api.bellafleur-benly.com/status?sid=$sid"
```

---

## Postman Collection
ไฟล์ `Bellafleur-API.postman_collection.json` แนบมาด้วย ใช้ได้ทันที:
- ตัวแปรระดับคอลเลกชัน: `baseUrl` (ค่าเริ่มต้น = `https://api.bellafleur-benly.com`), `sid`, `txID`
- **Core**:
  - `POST {{baseUrl}}/start-auth` (Body ใช้ `{"sid":"{{sid}}"}`; Header `Idempotency-Key: {{sid}}`)
  - `GET  {{baseUrl}}/status?sid={{sid}}`
  - `POST {{baseUrl}}/renew-link` (Body `{"sid":"{{sid}}"}`)
- **Advanced**:
  - `POST {{baseUrl}}/dlt/callback` (Body `{"sid":"{{sid}}","txID":"{{txID}}","event":"AUTH_SUCCESS"}`)
  - `GET  {{baseUrl}}/config`

> มีสคริปต์ให้: ถ้า `sid` ว่าง จะ auto‑gen ด้วย `{{$guid}}`; และหลัง `start-auth` จะเซ็ต `txID` อัตโนมัติจาก response

---

## Roadmap (แนะนำภายหลัง)
- เปลี่ยน sessions จาก in‑memory → Redis
- เพิ่ม Metrics/Alerting
- เพิ่ม Retry/Backoff, และ Hard‑limit per IP/UA ที่ละเอียดขึ้น
- เพิ่มชุดทดสอบอัตโนมัติ (e.g. GitHub Actions)

