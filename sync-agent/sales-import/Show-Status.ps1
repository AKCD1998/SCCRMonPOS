param()
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$file='\\100.90.166.72\D\SCCRM-HQ-LiveSync-20261024\sales-import\status\health.json'
$form=New-Object Windows.Forms.Form;$form.Text='SCCRM — สถานะรับบิลจากสาขาเข้า HQ';$form.Width=900;$form.Height=470;$form.StartPosition='CenterScreen'
$label=New-Object Windows.Forms.Label;$label.Dock='Top';$label.Height=60;$label.Padding=New-Object Windows.Forms.Padding 10;$form.Controls.Add($label)
$grid=New-Object Windows.Forms.DataGridView;$grid.Dock='Fill';$grid.ReadOnly=$true;$grid.AllowUserToAddRows=$false;$grid.AutoSizeColumnsMode='Fill';$form.Controls.Add($grid);$grid.BringToFront()
$timer=New-Object Windows.Forms.Timer;$timer.Interval=5000
$refresh={try{$health=Get-Content -LiteralPath $file -Raw -Encoding UTF8|ConvertFrom-Json;$at=[DateTimeOffset]::Parse($health.at).ToLocalTime().ToString('dd/MM/yyyy HH:mm:ss');$label.Text='ระบบรับบิล: '+$(if($health.state -ceq 'running'){'ทำงานอยู่'}else{'รอเชื่อมต่อ'})+'     อัปเดตเมื่อ: '+$at+"`r`nบิลเดิมที่มีใน HQ จะคงข้อมูลไว้โดยไม่เขียนทับ หน้านี้ใช้ดูสถานะเท่านั้น";$names=@{pending='รอนำเข้า';running='กำลังนำเข้า';retry='รอลองใหม่';review='พักไว้ (คงข้อมูล HQ)';succeeded='นำเข้าแล้ว'};$dt=New-Object Data.DataTable;foreach($n in @('สาขา','เปิดใช้งาน','สถานะ','จำนวนบิล','สำเร็จล่าสุด')){$null=$dt.Columns.Add($n)};foreach($r in @($health.queue)){$last=if($r.last_completed_at){[DateTime]::SpecifyKind([DateTime]::Parse($r.last_completed_at),[DateTimeKind]::Utc).ToLocalTime().ToString('dd/MM/yyyy HH:mm:ss')}else{'—'};$state=if($r.state){$names[[string]$r.state]}else{'ยังไม่มีรายการ'};$null=$dt.Rows.Add([string]$r.branch_code,$(if($r.enabled){'เปิด'}else{'พัก'}),$state,[string]$r.jobs,$last)};$grid.DataSource=$dt}catch{$label.Text='ยังอ่านสถานะ HQ ไม่ได้ กรุณาตรวจ Tailscale และการเชื่อมต่อเครื่อง HQ'}}
$timer.Add_Tick($refresh);$form.Add_Shown({& $refresh;$timer.Start()});$form.Add_FormClosed({$timer.Stop();$timer.Dispose()});$null=$form.ShowDialog();$form.Dispose()
