- เพิ่มเวลาตรวจฐาน AdaPos เป็น 60 วินาทีต่อขั้น รองรับช่วงที่ SQL Server อ่านโครงสร้างช้า
- ตัวติดตั้งแสดงขั้นตอนที่กำลังตรวจ และแยกข้อความรหัสผ่านผิดกับการอ่านฐานหมดเวลา
- คงการตรวจบัญชีอ่านอย่างเดียวและสิทธิ์เครื่องเดิมทั้งหมด พนักงานเลือกอัปเดตเองได้

Branch 001 POS1/POS2 share SC_001's AdaAcc. The prior installer allowed ten
seconds per metadata command; a read-only catalog count was observed taking
38 seconds despite successful authentication. Setup now uses a 15-second
connection budget and 60 seconds per verification command, with phase progress
and safe error classification. This accommodates slow responses; it does not
claim to resolve the underlying SQL Server latency.

All original role, database/table write-permission, receipt-column and branch
checks remain unchanged and fail closed. No SQL accounts, permissions, server
settings, AdaPos data or central promotion rules are changed. The six approved
company devices, including POS2, remain approved. Existing installations do not
need a mandatory update.
