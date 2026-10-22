- บันทึกหน่วยสินค้าที่ขายจริงจาก AdaPos พร้อม SKU และจำนวน เพื่อเปิดดูประวัติสมาชิกบนเว็บ StockDay
- หน้าสมาชิกบนเว็บเปิดประวัติแยกตามบิล พร้อมวันเวลาไทย ราคา และรายการคืนสินค้า
- ใช้ฐานสมาชิก Supabase เดิม อัปเดตโปรแกรมได้ตามสะดวก รุ่นเก่ายังสมัครและบันทึกบิลได้

SCCRMonPOS 1.3.3 captures `FTPunCode` and `FTSdtUnitName` from the receipt detail,
preserves them in pending receipt data and sends optional `unitCode`/`unitName`
with a member claim. The existing installer also checks these readable columns.
The web history shows unknown units honestly for older bills; this release does
not infer or rewrite historical units. All AdaPos access remains SELECT-only.
The installer includes the same connection setup as 1.3.2 and preserves staff
sessions. Updating remains optional and does not change central promotions.
