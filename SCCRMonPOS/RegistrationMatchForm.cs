using System;
using System.Drawing;
using System.Windows.Forms;

namespace SCCRMonPOS
{
    internal sealed class RegistrationMatchForm : Form
    {
        private readonly DataGridView _names;
        internal string SelectedCandidateId { get; private set; }
        internal bool UseExisting { get; private set; }

        internal RegistrationMatchForm(RegistrationCandidate[] candidates)
        {
            Text = "เคยสมัครไว้แล้วใช่ไหม?";
            Font = new Font("Tahoma", 10);
            ClientSize = new Size(570, 360);
            MinimumSize = new Size(586, 399);
            StartPosition = FormStartPosition.CenterParent;
            MinimizeBox = false;
            ShowInTaskbar = false;
            var heading = new Label { Dock = DockStyle.Top, Height = 76,
                Padding = new Padding(16, 14, 16, 4),
                Text = "พบเบอร์นี้ในระบบ\nถามลูกค้าว่าเคยสมัครไว้ในชื่อด้านล่างนี้ไหม" };
            var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 90, Padding = new Padding(12, 12, 4, 4), WrapContents = true };
            var existing = new Button { Text = "ใช่ ใช้ชื่อเดิม", Width = 164, Height = 40 };
            var separate = new Button { Text = "คนละคน สมัครใหม่", Width = 174, Height = 40 };
            var cancel = new Button { Text = "กลับไปแก้ข้อมูล", Width = 164, Height = 40, DialogResult = DialogResult.Cancel };
            _names = new DataGridView { Dock = DockStyle.Fill, ReadOnly = true, AllowUserToAddRows = false,
                AllowUserToDeleteRows = false, RowHeadersVisible = false, MultiSelect = false,
                SelectionMode = DataGridViewSelectionMode.FullRowSelect, AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill };
            _names.Columns.Add("name", "ชื่อที่เคยสมัคร");
            _names.Columns.Add("phone", "เบอร์โทร");
            _names.Columns.Add("code", "รหัสสมาชิก");
            _names.Columns[0].FillWeight = 48;
            _names.Columns[1].FillWeight = 23;
            _names.Columns[2].FillWeight = 29;
            _names.DefaultCellStyle.WrapMode = DataGridViewTriState.True;
            _names.AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.AllCells;
            _names.RowTemplate.MinimumHeight = 28;
            foreach (var candidate in candidates)
            {
                int index = _names.Rows.Add(candidate.Name + (candidate.CanUseExisting ? "" : " (ปิดใช้งานไว้)"), candidate.Phone, candidate.MemberCode);
                _names.Rows[index].Tag = candidate;
            }
            existing.Click += (s, e) => {
                if (_names.CurrentRow == null) return;
                var selected = (RegistrationCandidate)_names.CurrentRow.Tag;
                if (!selected.CanUseExisting) return;
                SelectedCandidateId = selected.Id;
                UseExisting = true;
                DialogResult = DialogResult.OK;
                Close();
            };
            separate.Click += (s, e) => { UseExisting = false; DialogResult = DialogResult.OK; Close(); };
            _names.CurrentCellChanged += (s, e) => existing.Enabled = (_names.CurrentRow?.Tag as RegistrationCandidate)?.CanUseExisting == true;
            existing.Enabled = (_names.CurrentRow?.Tag as RegistrationCandidate)?.CanUseExisting == true;
            buttons.Controls.AddRange(new Control[] { existing, separate, cancel });
            Controls.Add(_names);
            Controls.Add(buttons);
            Controls.Add(heading);
            CancelButton = cancel;
        }
    }
}
