# SCCRMonPOS Loyalty Safeguard: Drug Exclusion

วันที่อัปเดต: 2026-05-17

## 1) ทำไมต้องมีเอกสารนี้
เอกสารนี้สรุปสิ่งที่ถูก implement เพิ่มใน `SCCRMonPOS` เพื่อป้องกันการให้แต้มกับสินค้ากลุ่มยา
โดยอ้างอิงฐานข้อมูลสินค้าจาก `PaaSRTSM-project`

เป้าหมายของรอบนี้ไม่ใช่ “คิดแต้มอัตโนมัติจากทุกบรรทัดในบิล”
แต่คือ:
- เพิ่ม safeguard ที่ใช้งานได้จริงก่อน
- บังคับให้มีการคัดกรองสินค้า
- ทำให้การให้แต้มอิงเฉพาะยอดสินค้าที่ “ยืนยันแล้วว่าไม่ใช่ยา”

## 2) สิ่งที่แก้ในโปรแกรม POS

### 2.1 เพิ่ม client สำหรับเรียกระบบคัดกรองสินค้า
ไฟล์ใหม่:
- `ProductEligibilityClient.cs`

หน้าที่:
- เรียก `PaaSRTSM-project` ที่ endpoint:
  - `GET /api/loyalty/products/eligibility`
- ส่ง `barcode` หรือ `company_code`
- ส่ง header:
  - `x-pos-api-key`
- parse response กลับมาเป็น `ProductEligibilityResult`

behavior:
- ถ้าหาสินค้าไม่เจอ:
  - throw `ProductEligibilityNotFoundException`
- ถ้าเชื่อมต่อไม่ได้ / timeout / key ผิด:
  - throw `ProductEligibilityLookupException`

### 2.2 เพิ่ม config ใหม่ใน POS
แก้ไฟล์:
- `App.config`

เพิ่ม key:
- `ProductEligibilityApiBaseUrl`
- `ProductEligibilityApiKey`
- `RequireProductScreeningForPoints`

ความหมาย:
- `ProductEligibilityApiBaseUrl`
  - base URL ของ `PaaSRTSM-project` admin-api
- `ProductEligibilityApiKey`
  - key ที่ต้องตรงกับ `POS_API_KEYS` ฝั่ง service
- `RequireProductScreeningForPoints`
  - ถ้า `true` จะบังคับ flow คัดกรองสินค้า

### 2.3 ส่ง dependency เข้า popup หลัก
แก้ไฟล์:
- `TrayAppContext.cs`

สิ่งที่เพิ่ม:
- instantiate `ProductEligibilityClient`
- อ่าน config `RequireProductScreeningForPoints`
- ส่งทั้งสองอย่างเข้า `MemberPointForm`

## 3) สิ่งที่แก้ในหน้าสะสมแต้ม
แก้ไฟล์:
- `MemberPointForm.cs`

### 3.1 ขยาย Step 2 ของฟอร์ม
เดิม:
- Step 2 รับแค่:
  - หมายเลขใบเสร็จ
  - ยอดบิล
- แล้วคิดแต้มจาก:
  - `floor(bill / BahtPerPoint)`

รอบนี้:
- ถ้า `RequireProductScreeningForPoints = true`
  - Step 2 จะมีส่วน “คัดกรองสินค้า” เพิ่มเข้ามา

UI ใหม่ที่เพิ่ม:
- ช่องกรอก/สแกน `รหัสสินค้า`
- ปุ่ม `ตรวจสอบ`
- ตารางรายการสินค้าที่คัดกรองแล้ว
- ปุ่ม `ล้างรายการ`
- summary:
  - จำนวนรายการที่ร่วมสะสมแต้ม
  - จำนวนรายการที่ไม่ร่วมสะสมแต้ม
  - จำนวนรายการที่ยังต้องตรวจสอบ
- checkbox ยืนยันว่า:
  - “ยอดข้างต้นไม่รวมยา/สินค้าที่ไม่ร่วมสะสมแต้ม”

### 3.2 กติกาการคัดกรองในหน้าจอ
เมื่อพนักงานสแกนหรือกรอกรหัสสินค้า:
- โปรแกรมเรียก `ProductEligibilityClient.LookupAsync(code)`
- ถ้าฐานข้อมูลตอบว่า:
  - `eligible = true`
    - แสดงสถานะ `ร่วมสะสมแต้ม`
  - `reason = medicine_blocked`
    - แสดงสถานะ `ยา - ไม่ร่วมสะสม`
  - `reason = unknown_product_kind`
    - แสดงสถานะ `ยังไม่จัดประเภท`
- ถ้าหาสินค้าไม่เจอ:
  - เพิ่มรายการเป็น unresolved
  - บล็อกการยืนยันรายการสะสมแต้ม

### 3.3 เงื่อนไขที่ “ห้ามกด confirm ผ่าน”
ตอนกด confirm ระบบจะ block ถ้าเกิดอย่างใดอย่างหนึ่ง:
- ยังไม่ได้ตั้งค่า product screening service
- ยังไม่ได้คัดกรองสินค้าเลยแม้แต่ 1 รายการ
- มีสินค้าที่:
  - ไม่พบในฐานข้อมูล
  - หรือยังไม่ถูกจัดประเภท
- ยังไม่ได้ติ๊ก checkbox ยืนยันว่าใช้ยอด eligible subtotal เท่านั้น

## 4) วิธีคิดแต้มหลังแก้
สูตรคิดแต้ม “ยังเหมือนเดิม”:
```text
points = floor(eligible_subtotal / 10)
```

สิ่งที่เปลี่ยนคือ:
- ช่องจำนวนเงินใน Step 2 ไม่ควรใส่ “ยอดบิลเต็ม”
- แต่ต้องใส่ “ยอดที่ร่วมสะสมแต้มเท่านั้น”

ตัวอย่าง:
- ยอดบิลเต็ม = 820 บาท
- มียา 300 บาท
- มีสินค้าทั่วไป 520 บาท
- ยอดที่ต้องกรอกเพื่อคิดแต้ม = 520 บาท
- แต้มที่ได้ = `floor(520 / 10) = 52`

## 5) ข้อจำกัดสำคัญของเวอร์ชันนี้
เวอร์ชันนี้ยัง “ไม่ใช่” line-item automatic calculation

โปรแกรมยังไม่สามารถ:
- ดึงรายการสินค้าทั้งบิลจาก POS โดยตรง
- ดึงราคาแต่ละ SKU จาก POS popup อัตโนมัติ
- รวม eligible subtotal ให้เองจาก line items

ดังนั้น safeguard รอบนี้เป็นแบบ:
- screen SKU ทีละตัว
- ให้พนักงานกรอก eligible subtotal เอง
- บังคับยืนยันว่า subtotal ที่กรอกไม่รวมยา

สรุปเชิงเทคนิค:
- ตอนนี้ระบบช่วย “คุมสิทธิ์สินค้า”
- แต่ยังไม่ได้ “คำนวณยอด eligible subtotal อัตโนมัติ”

## 6) ทำไมเลือก approach นี้ก่อน
เหตุผลหลัก:
- POS companion เดิมรับแค่ยอดบิลรวม
- ไม่มี line-item payload ใน flow เดิม
- ถ้าพยายามอนุมานจากยอดรวม จะยังเสี่ยงให้แต้มผิดกับสินค้ากลุ่มยา

ดังนั้นรอบนี้เลือกทางที่ conservative กว่า:
- ถ้าไม่ชัด = ไม่ให้ผ่าน
- ถ้า product kind ยังไม่พร้อม = ไม่ให้แต้ม
- ให้พนักงานระบุยอดเฉพาะสินค้าที่ร่วมสะสมแต้ม

## 7) รายการไฟล์ที่แก้ใน SCCRMonPOS
เพิ่ม:
- `ProductEligibilityClient.cs`
- `SAFEGUARD_LOYALTY_DRUG_EXCLUSION.md`

แก้:
- `MemberPointForm.cs`
- `TrayAppContext.cs`
- `App.config`
- `SCCRMonPOS.csproj`

## 8) วิธีตั้งค่าก่อนใช้งานจริง
ใน `App.config` ให้ตั้งค่า:

```xml
<add key="ProductEligibilityApiBaseUrl" value="https://<your-admin-api-host>" />
<add key="ProductEligibilityApiKey" value="<same-key-as-POS_API_KEYS>" />
<add key="RequireProductScreeningForPoints" value="true" />
```

และฝั่ง `PaaSRTSM-project` ต้องตั้ง env:

```env
POS_API_KEYS=your-pos-key
```

หมายเหตุ:
- ถ้าเปิด `RequireProductScreeningForPoints=true`
- แต่ไม่ได้ตั้ง URL/API key ให้ครบ
- โปรแกรมจะ block การสะสมแต้มใน Step 2

## 9) ผล verification ล่าสุด
สิ่งที่รันแล้ว:
- `npm test` ใน `PaaSRTSM-project` ผ่าน
- `dotnet build SCCRMonPOS.csproj -c Debug` ผ่าน

## 10) สิ่งที่ควรทำต่อ ถ้าต้องการให้แน่นกว่านี้
ลำดับถัดไปที่ควรทำ ถ้าต้องการลด manual step:
- เชื่อม POS line items เข้ากับ popup หรือ companion process
- ส่ง SKU + quantity + line amount มาทีละรายการ
- ให้โปรแกรมคำนวณ eligible subtotal อัตโนมัติ
- เก็บ audit log ว่าในบิลนั้นมี SKU อะไรถูก exclude เพราะเป็นยา
- เพิ่ม fallback classification workflow สำหรับสินค้าที่ `unknown_product_kind`

จนกว่าจะมี line-item integration จริง
เอกสารนี้ถือเป็น baseline safeguard ที่ใช้งานได้และปลอดภัยกว่าการให้แต้มจากยอดรวมเต็มบิล
