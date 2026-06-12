# SCCRMonPOS — How It Works (Current State)

วันที่วิเคราะห์: 2026-06-11 (จาก commit `e4cd4b5`)
ผู้วิเคราะห์: Claude (อ่านโค้ดทั้ง repo + git history — **ไม่มีการแก้โค้ดใดๆ ในรอบนี้**)

> **เอกสารนี้เติมส่วนที่เอกสารเดิมยังไม่ cover** — ไม่เขียนซ้ำ:
> - `README.md` → forensic ของ AdaPos DB (schema `TPSTSalHD`/`TPSTSalDT`/`TPSTSalRC`, polling query, security pain points) — **ยังถูกต้อง ใช้อ้างอิงต่อได้**
> - `docs/adasoft/project_sccrmonpos.md` → ภาพรวมยุคแรก (พ.ค. 2026) — **ล้าสมัยบางส่วน** เอกสารนี้คือฉบับอัปเดต
> - `SCCRMonPOS/SAFEGUARD_LOYALTY_DRUG_EXCLUSION.md` → ที่มาของ logic กันแต้มยา — ยังอ้างอิงได้ แต่ implementation ปัจจุบันเปลี่ยนไปแล้ว (ดู §6)

---

## 1) แอปนี้คืออะไร (TL;DR)

**SCCRMonPOS = โปรแกรมเสริมข้างเครื่องแคชเชียร์ (POS companion)** เป็น C# .NET Framework 4.8 **WinForms tray app** (ไอคอนมุมขวาล่าง ไม่มีหน้าต่างหลัก) ทำหน้าที่เป็น "สะพาน" ระหว่าง 2 ระบบ:

```
AdaPos HyperMart (โปรแกรมขายหน้าร้าน, closed-source)
        │  อ่านตรงจาก SQL Server (database: AdaAcc) ทุก 3 วินาที
        ▼
   SCCRMonPOS (tray app — repo นี้)
        │  HTTPS + JSON (เหมือน fetch ใน JS)
        ▼
SCCRM backend (Node/Express บน Render: sc-official-website.onrender.com)
   → ระบบสมาชิก/แต้มสะสม (loyalty)
```

พูดแบบเทียบกับโลก JS ที่คุณคุ้น: **มันคือ "background service + UI form" ที่ poll ฐานข้อมูลฝั่งหนึ่ง แล้วยิง REST API ไปอีกฝั่งหนึ่ง** — concept เดียวกับสคริปต์ Node ที่ `setInterval` query Postgres แล้ว `fetch()` ไป API เพียงแต่เขียนด้วย C# และ UI เป็น WinForms แทน React

---

## 2) Flow การใช้งานจริง (เวอร์ชันปัจจุบัน)

ปรัชญาปัจจุบันคือ **"cashier-triggered ทุกอย่าง ไม่มี popup อัตโนมัติ"** (เขียนคอมเมนต์ไว้ใน `TrayAppContext` เลย):

1. **เปิดโปรแกรม** → `Program.cs` กัน double-instance ด้วย Mutex → สร้าง `TrayAppContext`
2. **Staff login** → ถ้าไม่มี token (หรือหมดอายุ) เด้ง `StaffLoginForm` → ยิง `POST /api/sccrm/auth/staff-device` → ได้ staff token เก็บลงดิสก์แบบเข้ารหัส DPAPI (`StaffAuthManager`)
3. **`AdaPosWatcher` เริ่มทำงานเงียบๆ** → poll DB AdaAcc ทุก 3 วิ หาบิลใหม่ → เก็บบิลล่าสุดไว้ใน memory (`_standingByReceipt`) เฉยๆ **ไม่เด้งอะไรขึ้นมา**
4. **ลูกค้าจ่ายเงินเสร็จ → แคชเชียร์กด `Ctrl+Alt+Q`** (global hotkey) หรือดับเบิลคลิก tray icon
5. **`MemberClaimForm` เปิดขึ้น** พร้อม **pre-fill บิลล่าสุด** (เลขที่บิล, รายการสินค้า, ยอดรวม) — แคชเชียร์พิมพ์เลขบิลเองก็ได้ (`LoadReceiptByDocNo`)
6. แคชเชียร์**ค้นหาสมาชิก** (เบอร์โทร/ชื่อ/รหัสสมาชิก → `GET /api/members/search`) หรือ**สมัครสมาชิกใหม่** (`NewMemberForm`) หรือ**แก้ไขข้อมูลสมาชิก** (ต้องใส่ PIN `StaffEditPin` ก่อน)
7. โปรแกรมคำนวณแต้ม: **ตัดสินค้าที่ชื่อขึ้นต้นด้วย "เภสัช" ออก** (ยา = ไม่ได้แต้ม) → ยอดที่เหลือ ÷ 25 บาท = แต้ม
8. กดยืนยัน → `POST /api/loyalty/claims` → backend บันทึกแต้ม → แสดงผล "สะสมแต้มสำเร็จ ได้รับ X แต้ม"
9. ถ้ามีบิล **return (คืนสินค้า, DocType='9')** → watcher ตรวจเจอ → เคลียร์บิลค้างใน memory ทิ้ง

---

## 3) แผนที่ไฟล์ — อันไหน "มีชีวิต" อันไหน "ซาก"

ประเด็นสำคัญที่สุดสำหรับคนกลับมาอ่านโค้ด: **เกือบครึ่งหนึ่งของไฟล์ใน repo เป็น legacy ที่ไม่ได้อยู่ใน flow ปัจจุบันแล้ว** เพราะสถาปัตยกรรมเปลี่ยน 2 รอบ (ดู timeline §5)

### 🟢 LIVE — เส้นทางหลักปัจจุบัน

| ไฟล์ | หน้าที่ | เทียบกับโลก JS |
|---|---|---|
| `Program.cs` | entry point + single-instance + global error handler | `index.js` + `process.on('uncaughtException')` |
| `TrayAppContext.cs` | ตัวประสานทุกอย่าง: tray icon, เริ่ม watcher, hotkey, เปิดฟอร์ม, watermark | `App.jsx` + service container |
| `AdaPosWatcher.cs` | **หัวใจของแอป** — poll SQL Server `AdaAcc` ทุก 3 วิ บน background thread; auto-discover server (config → `.\SQLEXPRESS` → registry TCP port); จัดการบิลที่ยังเขียนไม่เสร็จ (pending re-check, timeout 10 นาที); ยิง events | `setInterval` + `pg.query()` + `EventEmitter` |
| `ReceiptWorkflowStore.cs` | `ReceiptWatermark` + store — จำตำแหน่งบิลล่าสุดที่อ่านแล้ว (JSON ลงดิสก์) กันอ่านซ้ำหลัง restart | เก็บ cursor/offset ลงไฟล์ |
| `ApiClient.cs` | HTTP client รวมทุก endpoint + DTO classes + retry/error mapping | `api.js` ที่รวม `fetch()` ทุกตัว |
| `StaffAuthManager.cs` | เก็บ staff token เข้ารหัส DPAPI ลงดิสก์ | `localStorage` แต่เข้ารหัสด้วย key ของ Windows user |
| `GlobalHotKeyManager.cs` | ลงทะเบียน `Ctrl+Alt+Q` ระดับ OS (`RegisterHotKey` WinAPI) | ไม่มีใน browser — OS-level shortcut |
| `MemberClaimForm.cs` + `.Designer.cs` | **ฟอร์มหลัก**: โหลดบิล, ค้นสมาชิก, คำนวณแต้ม (ตัด "เภสัช"), ยืนยัน claim | หน้า React หลัก 1 หน้า |
| `StaffLoginForm.cs` + `.Designer.cs` | ฟอร์ม login พนักงาน | หน้า login |
| `NewMemberForm.cs` + `.Designer.cs` | สมัคร/แก้ไขสมาชิก (ชื่อ เพศ วันเกิด ฯลฯ) → `POST/PUT /api/members` | ฟอร์ม CRUD |
| `PharmacyMedRecordForm.cs` | บันทึกข้อมูลสุขภาพ (น้ำหนัก/ความดัน/โรคประจำตัว/แพ้ยา) — เปิดจาก NewMemberForm | ฟอร์มย่อย |
| `Models/PosReceipt.cs` | DTO บิล + รายการสินค้า | `interface` / object shape |
| `Models/Member.cs`, `Models/PharmacyMedRecord.cs` | DTO | |
| `App.config` | คอนฟิกทั้งหมด (API URL, key, DB credentials, hotkey, points rule) | `.env` |

### 🟡 ZOMBIE — อยู่ใน .csproj (ถูก compile) แต่**ไม่มีใครเรียกใช้แล้ว**

| ไฟล์ | เคยเป็นอะไร |
|---|---|
| `MemberPointForm.cs` (46KB!) | ฟอร์มสะสมแต้มยุคแรก (คีย์ยอดเงินเอง + scanner) — ถูกแทนด้วย `MemberClaimForm` |
| `ScannerInputService.cs` | global keyboard hook จับ barcode scanner — แนวทางยุคแรก เลิกใช้เมื่อเปลี่ยนเป็นอ่าน DB ตรง |
| `OfflineQueue.cs` | คิว retry ตอน offline — ใช้โดย MemberPointForm เท่านั้น |
| `TransactionRepository.cs` | audit log CSV — ใช้โดย MemberPointForm เท่านั้น |
| `ProductEligibilityClient.cs` | เรียก API คัดกรองยาจาก PaaSRTSM (ดู §6) — ใช้โดย MemberPointForm เท่านั้น |

### 🔴 ORPHAN — มีไฟล์อยู่ในโฟลเดอร์ แต่**ไม่อยู่ใน .csproj เลย** (ไม่ถูก compile)

| ไฟล์ | เคยเป็นอะไร |
|---|---|
| `ClaimQrForm.cs` | popup QR ให้ลูกค้าสแกน claim แต้มเองหลังจ่ายเงิน (countdown) — ฟีเจอร์ 2 มิ.ย. ที่ถูกถอดออกจาก flow |
| `LoadingOverlayForm.cs` | overlay ระหว่างรอ — ใช้กับ ClaimQrForm |
| `MemberRepository.cs` | local member cache ยุคแรกสุด |
| `lib/QRCoder/` | ไลบรารี gen QR — ใช้กับ ClaimQrForm |
| `MemberPointForm.Designer.cs`? | (ไม่มี — ฟอร์มนั้นสร้าง UI ด้วยโค้ดล้วน) |

> ⚠️ ระวังตอนอ่านโค้ด: ถ้าเปิด `MemberPointForm.cs` หรือ `ScannerInputService.cs` แล้วงง "ทำไม flow ไม่ตรงกับที่เห็นตอนใช้งาน" — เพราะมันคือเวอร์ชันเก่าที่ไม่ได้รันแล้วนั่นเอง

---

## 4) Backend endpoints ที่แอปเรียก (จาก `ApiClient.cs`)

ทั้งหมดชี้ไปที่ `ApiBaseUrl` = `https://sc-official-website.onrender.com` (repo `currentSC-official-website-project` — Node/Express + Postgres ที่คุณเขียนเอง)

| Endpoint | Auth | ใช้ทำอะไร | ใช้อยู่จริง? |
|---|---|---|---|
| `POST /api/sccrm/auth/staff-device` | – | login พนักงาน → staff token | ✅ |
| `GET /api/members/search?q=` | staff token | ค้นสมาชิก (ชื่อ/เบอร์/รหัส) | ✅ |
| `GET /api/members/:id` | **PosApiKey** header | ดึงรายละเอียดสมาชิก (แก้ไข) | ✅ |
| `PUT /api/members/:id` | **PosApiKey** | แก้ไขข้อมูลสมาชิก | ✅ |
| `POST /api/members` (fallback `POST /api/sccrm/customers`) | staff token | สมัครสมาชิกใหม่ | ✅ |
| `POST /api/loyalty/claims` | staff token | **บันทึกแต้มจากบิล (เส้นหลัก)** | ✅ |
| `POST /api/sccrm/customers/resolve-scan-token` | staff token | แปลง QR ลูกค้า → member | 🟡 (scanner flow เดิม) |
| `GET /api/sccrm/customers/search?phone=` | staff token | ค้นด้วยเบอร์ (ยุคแรก) | 🟡 |
| `POST /api/sccrm/points/earn` | staff token | ให้แต้มแบบคีย์ยอดเอง (ยุคแรก) | 🟡 (MemberPointForm) |
| `POST /internal/crm/pos/claim-token` | internal token | สร้าง claim token สำหรับ QR | 🔴 (ClaimQrForm) |
| `POST /internal/crm/pos/sale-event` | internal token | ลงทะเบียน sale event | 🔴 |

---

## 5) Timeline — เกิดอะไรขึ้นบ้าง (จาก git history)

สถาปัตยกรรมเปลี่ยน **3 ยุค** — นี่คือสาเหตุที่โค้ด "ไม่ปะติดปะต่อ":

```
ยุค 1 (พ.ค. 2026): "Scanner + คีย์ยอดเอง"
  ├ 190ae59 (15 พ.ค.) Harden for MVP demo — security, audit log
  ├ 823fbaa (15 พ.ค.) fix: opaque staff token ใน IsJwtExpired
  ├ MemberPointForm + ScannerInputService + OfflineQueue + TransactionRepository
  ├ (17 พ.ค.) SAFEGUARD: เพิ่ม ProductEligibilityClient เช็คยาผ่าน PaaSRTSM API
  └ ปัญหา: แคชเชียร์ต้องคีย์ยอดเงินเอง + สแกนทีละชิ้น → ช้า

ยุค 2 (2-3 มิ.ย. 2026): "อ่าน DB ตรง + QR ให้ลูกค้า claim เอง"
  ├ 9a1ebae (2 มิ.ย.) post-sale claim QR flow + countdown  ← ClaimQrForm เกิด
  ├ 7f84c91 (3 มิ.ย.) sale event registration + claim token
  ├ AdaPosWatcher เกิดขึ้น — อ่านบิลจาก SQL Server ตรง (วิธีที่ 3 ในแผนเดิม
  │   ชนะ UI Automation และ OCR เพราะเจอ DB credentials ใน AdaPurge.ini)
  └ ปัญหา: popup QR อัตโนมัติหลังทุกบิลรบกวนหน้าจอขาย

ยุค 3 (3-11 มิ.ย. 2026 = ปัจจุบัน): "Cashier-triggered ทุกอย่าง"
  ├ 2907865 (3 มิ.ย.) member management + API key integration
  ├ 5d9dd42 (3 มิ.ย.) fix: restore minimized MemberClaimForm
  ├ 6e05def + b5b4d12 (3-4 มิ.ย.) fix: PosApiKey + gender handling
  ├ 4052de4 (11 มิ.ย.) NewMemberForm + PharmacyMedRecordForm + Models
  ├ e4cd4b5 (11 มิ.ย.) fix: gender selection logic
  └ ผลลัพธ์: ไม่มี popup อัตโนมัติ — watcher แค่ cache บิลไว้
      แคชเชียร์กด Ctrl+Alt+Q เมื่อลูกค้าอยากสะสมแต้มเท่านั้น
```

**สิ่งที่ผ่านการแก้ไขแล้ว (อย่าสับสนว่าเป็นปัญหาปัจจุบัน):**
- ❌ "คีย์ยอดเงินเอง" → ✅ อ่านจาก DB อัตโนมัติแล้ว (gap ที่ระบุใน `project_sccrmonpos.md` ปิดแล้ว)
- ❌ "popup QR อัตโนมัติ" → ✅ ถอดออก เปลี่ยนเป็น hotkey
- ❌ "บิลถูกอ่านตอน header ยังเขียนไม่ครบ (total=0)" → ✅ มี pending re-check + timeout 10 นาที
- ❌ "restart แล้วอ่านบิลเก่าซ้ำ" → ✅ มี ReceiptWatermark ลงดิสก์
- ❌ "JWT check พังกับ opaque token" → ✅ แก้แล้ว (823fbaa)

---

## 6) จุดที่ "ของจริง" ต่างจากเอกสารเดิม

1. **การคัดกรองยา (drug exclusion):** เอกสาร SAFEGUARD บอกว่าใช้ `ProductEligibilityClient` เรียก API ของ PaaSRTSM — **ปัจจุบันไม่ใช่แล้ว** เส้นทางหลัก (`MemberClaimForm`) ใช้กติกาง่ายๆ ในเครื่อง: `productName.StartsWith("เภสัช")` → ตัดออกจากยอดคำนวณแต้ม (เพราะข้อมูลชื่อสินค้าจาก AdaPos ขึ้นต้นตามหมวดอยู่แล้ว) ส่วน ProductEligibilityClient เหลืออยู่แค่ในซาก MemberPointForm
2. **จุดเชื่อม AdaPos:** แผนเดิมเขียนไว้ 3 ทาง (UI Automation / OCR / DB) — สรุปจบที่ **DB ตรง** และ `AdaPosWatcher` ฉลาดกว่าแผน: ค้นหา server เองได้หลายทาง (config → local SQLEXPRESS → อ่าน TCP port จาก registry) และค้นหาชุดตาราง sale เอง (`SaleTableSet`)
3. **`App.config` บนเครื่อง dev ชี้ `.\SQLEXPRESS`** (ไม่ใช่ IP 192.168.0.127 ของหน้าร้าน) — แปลว่ามีคนเคยตั้งใจรันกับ SQL Express ในเครื่อง laptop มาก่อน
4. **BahtPerPoint = 25** (1 แต้ม / 25 บาท) — เอกสารเก่าบางที่บอก 10

---

## 7) ⚠️ ข้อสังเกตด้านความปลอดภัย (บันทึกไว้ ยังไม่แก้ตามคำสั่ง)

- `App.config` **commit ลง git พร้อม secrets จริง**: `PosApiKey`, `StaffEditPin` (123123), และ `sa/adasoft` ของ AdaPos DB — repo อยู่บน GitHub (`AKCD1998/SCCRMonPOS`) ถ้า repo เป็น public ถือว่ารั่วแล้ว ควรย้ายเป็น `App.Release.config` ที่ไม่ commit / Windows Credential Manager ในอนาคต
- PIN แก้ไขสมาชิกเทียบแบบ plaintext ในโค้ดฟอร์ม
- จุดอ่อนเชิงโครงสร้าง (sa account, plaintext INI, no VLAN) → มีครบใน `README.md` แล้ว ไม่เขียนซ้ำ

---

## 8) คำถามหลัก: จะพัฒนาต่อบน dev laptop (ไม่มี AdaSoft) ได้อย่างไร?

### 8.1 อะไร "รันได้เลย" บน laptop นี้ — มากกว่าที่คิด

สิ่งเดียวที่เครื่องนี้ไม่มีคือ **ฐานข้อมูล AdaAcc** ส่วนที่เหลือทำงานปกติหมด เพราะ:
- `AdaPosWatcher` ถูกออกแบบให้**ตายอย่างสุภาพ** — ต่อ DB ไม่ได้ก็แค่ขึ้น "AdaPos DB: ขาดการเชื่อมต่อ ⚠" ใน tray menu แล้ว retry ไปเรื่อยๆ แอปไม่ crash
- Backend คือ **Render ตัวจริง** (`sc-official-website.onrender.com`) — login พนักงาน, ค้นสมาชิก, สมัครสมาชิก, แก้ไขข้อมูล, แม้แต่ submit claim (ถ้าพิมพ์ข้อมูลบิล mock) ใช้ได้จากที่ไหนก็ได้ที่มีเน็ต

ดังนั้น **งาน UI ทั้งหมด + งานเชื่อม backend = ทำบน laptop ได้ 100%** มีแค่ "การจับบิลจริงจาก AdaPos" ที่ต้องทดสอบหน้าร้าน

### 8.2 Setup ขั้นต่ำเพื่อ build + รัน

1. ติดตั้ง **Visual Studio 2022 Community** (ฟรี) เลือก workload ".NET desktop development" และติ๊ก **.NET Framework 4.8 development tools/targeting pack**
   (มีโฟลเดอร์ `.idea` แปลว่าอาจเคยใช้ Rider — ก็ใช้ได้เหมือนกัน แต่ VS ฟรีและมี WinForms designer)
2. เปิด `SCCRMonPOS/SCCRMonPOS.csproj` → กด **F5** → build + รันพร้อม debugger
   ไม่มี NuGet ให้ restore เลย (โปรเจกต์ใช้ framework references ล้วน) — build ง่ายมาก
3. แอปจะเด้ง StaffLoginForm → login ด้วยบัญชีพนักงานจริง → tray icon ขึ้น → กด `Ctrl+Alt+Q` ใช้ฟอร์มได้เลย

### 8.3 ทางเลือกจัดการ "AdaPos ที่ไม่มี" (เรียงตามความคุ้ม)

| ทางเลือก | ทำยังไง | เหมาะกับ |
|---|---|---|
| **A. ปล่อยให้ watcher ตายเงียบ** (ศูนย์แรง) | ไม่ต้องทำอะไร หรือ set `AdaPosEnabled=false` ใน App.config | งาน UI/ฟอร์ม/เชื่อม backend — คือ 90% ของงานที่เหลือ |
| **B. ทำ Fake AdaAcc ในเครื่อง** ⭐ แนะนำถ้าจะแตะ watcher | ติดตั้ง SQL Server Express (ฟรี) → สร้าง DB `AdaAcc` → สร้าง 3 ตาราง `TPSTSalHD`/`TPSTSalDT`/`TPSTSalRC` ตาม column reference ใน `README.md` → เขียนสคริปต์ INSERT บิลปลอม → watcher เห็นบิลเหมือนอยู่หน้าร้านจริง (config ชี้ `.\SQLEXPRESS` อยู่แล้ว!) | พัฒนา/ดีบัก AdaPosWatcher, ทดสอบ flow ครบวงจรโดยไม่ต้องไปหน้าร้าน |
| **C. Mock ในโค้ด** | สร้าง `IFakeReceiptSource` ยัด PosReceipt ปลอมเข้า TrayAppContext | unit-test logic เฉพาะจุด (ยังไม่มี test ในโปรเจกต์) |

ตัวเลือก B คือสิ่งเดียวกับที่คุณทำเป็นประจำในโลก JS: "รัน Postgres local แทน DB production" — แค่เปลี่ยนเป็น SQL Server Express + schema ของ AdaPos

### 8.4 เทียบ Development Experience กับสิ่งที่คุณคุ้น

| สิ่งที่คุณทำใน JS/React | ใน SCCRMonPOS | ต่างแค่ไหน |
|---|---|---|
| `npm run dev` + Vite HMR | กด F5 ใน VS (build ~3-5 วิ แล้วแอปเปิดใหม่) | ❌ **ไม่มี hot reload** — นี่คือความต่างที่รู้สึกที่สุด แก้ UI 1 บรรทัด = ปิด-build-เปิดใหม่ |
| แก้ JSX เห็นผลทันที | WinForms: UI ส่วนใหญ่ในโปรเจกต์นี้**สร้างด้วยโค้ด** (`new Button { Bounds = ... }`) ไม่ใช่ลาก designer | เหมือนเขียน DOM ด้วย `document.createElement` ล้วนๆ ไม่มี JSX |
| `console.log` | `LogRuntime()` → ดูที่ `bin/Debug/data/runtime.log` หรือ breakpoint ใน VS (ดีกว่า console มาก) | VS debugger เหนือกว่า browser devtools สำหรับงานแบบนี้ |
| `fetch()` / axios | `ApiClient` + `async/await` | ✅ **แทบเหมือนเดิม** — C# `async Task` ≈ JS `async function`, `await` ใช้เหมือนกัน |
| Express backend + Postgres บน Render | **อันเดียวกันเป๊ะ** — backend ของแอปนี้คือโปรเจกต์ Node ที่คุณเขียนเองอยู่แล้ว | ✅ ฝั่ง backend DX เหมือนเดิม 100% — เพิ่ม endpoint ใหม่ใน Express → ให้ C# เรียก |
| EventEmitter / callbacks | C# `event` + `+=` handler | ✅ concept เดียวกัน |
| Single-threaded event loop | ⚠️ **หลาย thread จริง** — watcher อยู่คนละ thread กับ UI ห้ามแตะ control ข้าม thread (โค้ดใช้ `ScheduleOnUiThread`/`BeginInvoke` แก้) | ❗ นี่คือกับดักใหญ่สุดที่โลก JS ไม่มี — ถ้าเจอ crash แปลกๆ ตอนอัปเดต UI ให้สงสัยข้อนี้ก่อน |
| `.env` | `App.config` | คล้ายกัน แต่ค่าฝังตอน build ไม่อ่านจาก env runtime |
| `npm install <pkg>` | NuGet (โปรเจกต์นี้จงใจไม่ใช้เลย) | ecosystem เล็กกว่า npm แต่ที่ต้องใช้ก็มีครบ |

### 8.5 สิ่งที่ต้องเรียนเพิ่ม (เรียงลำดับความสำคัญ — ข้ามที่เหลือได้)

1. **C# พื้นฐานผ่านเลนส์ JS** (1-2 วัน): types/classes/properties, `async Task` ≈ `async/Promise`, LINQ ≈ `map/filter/reduce`, `event` ≈ EventEmitter — syntax ใกล้ JS กว่าที่คิดมาก
2. **WinForms event model** (ครึ่งวัน): ทุก control คือ object + event handler — เหมือน `addEventListener` ทั้งระบบ ไม่มี state/re-render แบบ React (อัปเดต UI = set property ตรงๆ เช่น `label.Text = "..."`)
3. **Threading + UI marshalling** (สำคัญสุดในโปรเจกต์นี้): กฎเหล็กคือ "แตะ UI ได้จาก UI thread เท่านั้น" — ดูตัวอย่างที่ `ScheduleOnUiThread` ใน TrayAppContext
4. **VS debugger**: breakpoint, step-over (F10), watch window — ใช้แทน console.log แล้วชีวิตจะดีขึ้น
5. **(ถ้าทำตัวเลือก B) SQL Server Express + SSMS**: ต่างจาก Postgres นิดเดียว (T-SQL vs PL/pgSQL) ใช้ความรู้ SQL เดิมได้ ~90%
6. *ไม่ต้องเรียนตอนนี้:* WPF, .NET 8/MAUI, Entity Framework, NuGet packaging — โปรเจกต์นี้ไม่ได้ใช้

### 8.6 Workflow ที่แนะนำ (สรุป)

```
งานหน้าตา UI / ฟอร์มใหม่ / แก้ flow สมาชิก-แต้ม
  → ทำบน laptop เต็มที่ (backend = Render จริง, AdaPosEnabled=false ก็ได้)
  → F5 รัน, ทดสอบกับสมาชิก test ใน DB จริง

งานที่แตะ AdaPosWatcher / การอ่านบิล
  → ทำตัวเลือก B (fake AdaAcc บน SQL Express local) → จำลองบิลได้เอง

ก่อน deploy จริง
  → build Release → copy bin/Release ไปเครื่อง FRONT2 → ทดสอบกับบิลจริง 2-3 ใบ
  → (ปัจจุบัน deploy = copy ไฟล์มือ ยังไม่มี installer/CI — เป็น improvement ในอนาคตได้)
```

**คำตอบตรงๆ:** DX จะไม่เหมือนโลก JS 100% — ที่หายไปคือ hot reload กับ npm ecosystem แต่ส่วนที่เหลือใกล้กว่าที่กลัว: async/await เหมือนกัน, event เหมือนกัน, backend คือ Express เดิมของคุณเอง และ "ปัญหาไม่มี AdaSoft" แก้ได้จริงด้วย SQL Express + ตารางปลอม 3 ตารางตามสเปคที่ forensic ไว้แล้วใน README

---

## 9) คำแนะนำลำดับถัดไป (ยังไม่ทำ รอสั่ง)

1. **ลบ/ย้าย dead code** (§3 🟡🔴) ไปโฟลเดอร์ `legacy/` หรือลบทิ้ง (git จำให้อยู่แล้ว) — ลดความงงได้มากที่สุดต่อแรงที่ลงน้อยที่สุด
2. **เอา secrets ออกจาก git** — ย้าย PosApiKey/PIN/DB password ไปไฟล์ config ที่ .gitignore
3. สร้างสคริปต์ `tools/create_fake_adaacc.sql` สำหรับตัวเลือก B
4. เพิ่ม unit tests กับ logic ล้วนๆ (CalcEligibleTotal, watermark compare, IsReceiptComplete)
