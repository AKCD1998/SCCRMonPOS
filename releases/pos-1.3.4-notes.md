- อนุญาตติดตั้งบน POS2 ที่ตรวจยืนยันผ่าน Tailscale และไฟล์ AdaSoftware แล้ว
- ตัวติดตั้งไฟล์เดียวพร้อมตัวช่วยตั้งค่าการเชื่อม AdaPos และประวัติสมาชิกครบ SKU หน่วย จำนวน วันเวลา
- เครื่องเดิมยังใช้รุ่นปัจจุบันต่อได้ พนักงานเลือกอัปเดตเองโดยไม่กระทบโปรโมชั่นส่วนกลาง

Adds the verified POS2 node to the compiled device policy, retaining the five
previously approved devices. Approval requires the exact company tailnet,
Tailscale node ID, hostname, assigned IP on a local adapter, and a readable local
AdaSoftware executable. No runtime policy override or broader approval is added.

The existing setup assistant is included unchanged. POS2 SQL connectivity and a
member-linked receipt must still be checked after installation; this release does
not claim that remote file access establishes a working SQL connection.

See docs/POS2_ONBOARDING.md for the read-only audit and private SMB credential
prompt. No credentials are embedded in the installer or helper.
