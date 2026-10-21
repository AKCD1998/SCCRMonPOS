using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace SCCRMonPOS.Updates
{
    public sealed class UpdateService : IDisposable
    {
        public const string DefaultManifestUrl = "https://raw.githubusercontent.com/AKCD1998/SCCRMonPOS/master/releases/stable.json";
        private readonly HttpClient _http;
        private readonly Func<string, UpdateRelease> _verify;
        private readonly string _root;
        private readonly string _executable;
        private readonly string _manifestUrl;
        private bool _checking;
        public UpdateRelease Available { get; private set; }
        public string Envelope { get; private set; }
        public string CurrentVersion { get; private set; }
        public event Action<UpdateRelease> UpdateAvailable;

        public UpdateService(string executable, string manifestUrl = DefaultManifestUrl)
            : this(executable, manifestUrl, new HttpClient { Timeout = TimeSpan.FromMinutes(3) }, UpdateRelease.Verify) { }

        internal UpdateService(string executable, string manifestUrl, HttpClient http, Func<string, UpdateRelease> verify)
        {
            _http = http; _verify = verify;
            _executable = Path.GetFullPath(executable);
            _root = Path.Combine(Path.GetDirectoryName(_executable), "data", "updates");
            _manifestUrl = manifestUrl;
            CurrentVersion = FileVersionInfo.GetVersionInfo(_executable).FileVersion ?? "รุ่นเริ่มต้น";
            try
            {
                var installed = _verify(File.ReadAllText(Path.Combine(_root, "installed.json")));
                installed.VerifyExecutable(_executable);
                CurrentVersion = installed.Version;
            }
            catch { /* First manual installation has no signed receipt yet. */ }
        }

        public async Task CheckAsync()
        {
            if (_checking) return;
            _checking = true;
            try
            {
                var uri = new Uri(_manifestUrl);
                if (uri.Scheme != "https" || !string.IsNullOrEmpty(uri.UserInfo)) throw new InvalidDataException("HTTPS manifest required.");
                using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20)))
                using (var response = await _http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, timeout.Token))
                {
                    if (response.StatusCode == HttpStatusCode.NotFound) { Available = null; Envelope = null; return; }
                    response.EnsureSuccessStatusCode();
                    if (response.RequestMessage.RequestUri.Scheme != "https") throw new InvalidDataException("HTTPS required.");
                    string envelope;
                    using (var stream = await response.Content.ReadAsStreamAsync())
                    using (var bytes = new MemoryStream())
                    {
                        var buffer = new byte[8192]; int read;
                        while ((read = await stream.ReadAsync(buffer, 0, buffer.Length, timeout.Token)) > 0)
                        {
                            if (bytes.Length + read > 65536) throw new InvalidDataException("Manifest is too large.");
                            bytes.Write(buffer, 0, read);
                        }
                        envelope = System.Text.Encoding.UTF8.GetString(bytes.ToArray());
                    }
                    var release = _verify(envelope);
                    if (release.DeviceAccessVersion != 1) { Available = null; Envelope = null; return; }
                    if (string.Equals(release.Sha256, UpdateRelease.HashFile(_executable), StringComparison.OrdinalIgnoreCase))
                    { Available = null; Envelope = null; return; }
                    Available = release; Envelope = envelope;
                    string reminder = Path.Combine(_root, "reminder.txt");
                    bool remind = !File.Exists(reminder) || File.ReadAllText(reminder) != release.ReleaseId ||
                        DateTime.UtcNow - File.GetLastWriteTimeUtc(reminder) > TimeSpan.FromHours(24);
                    if (remind)
                    {
                        Directory.CreateDirectory(_root);
                        File.WriteAllText(reminder, release.ReleaseId);
                        UpdateAvailable?.Invoke(release);
                    }
                }
            }
            finally { _checking = false; }
        }

        // Called only by the explicit Update button, never by the polling timer.
        public async Task<string> StageAsync(UpdateRelease release, string envelope, CancellationToken cancellation)
        {
            var signed = _verify(envelope);
            signed.RequireDeviceAccess();
            if (signed.Sha256 != release.Sha256 || signed.DownloadUrl != release.DownloadUrl || signed.Size != release.Size)
                throw new InvalidDataException("Release metadata changed.");
            release = signed;
            Directory.CreateDirectory(_root);
            string staging = Path.Combine(_root, "stage-" + Guid.NewGuid().ToString("N") + ".exe");
            try
            {
                using (var response = await _http.GetAsync(release.DownloadUrl, HttpCompletionOption.ResponseHeadersRead, cancellation))
                {
                    response.EnsureSuccessStatusCode();
                    var finalUri = response.RequestMessage.RequestUri;
                    if (finalUri.Scheme != "https" || !(finalUri.Host == "github.com" || finalUri.Host == "release-assets.githubusercontent.com" || finalUri.Host == "objects.githubusercontent.com"))
                        throw new InvalidDataException("Unexpected download host.");
                    if (response.Content.Headers.ContentLength.HasValue && response.Content.Headers.ContentLength.Value != release.Size)
                        throw new InvalidDataException("Unexpected download size.");
                    using (var source = await response.Content.ReadAsStreamAsync())
                    using (var file = new FileStream(staging, FileMode.CreateNew, FileAccess.Write, FileShare.None, 8192, true))
                    {
                        var buffer = new byte[8192]; int read; long total = 0;
                        while ((read = await source.ReadAsync(buffer, 0, buffer.Length, cancellation)) > 0)
                        {
                            total += read;
                            if (total > release.Size) throw new InvalidDataException("Unexpected download size.");
                            await file.WriteAsync(buffer, 0, read, cancellation);
                        }
                    }
                }
                release.VerifyExecutable(staging);
                return staging;
            }
            catch { if (File.Exists(staging)) File.Delete(staging); throw; }
        }

        public void StartHelper(string staged, string envelope)
        {
            using (var process = Process.GetCurrentProcess())
            {
                string job = UpdateInstaller.Prepare(_executable, staged, envelope, process.Id, process.StartTime.ToUniversalTime().Ticks);
                string helperDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SCCRMonPOS", "update-helper", Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(helperDirectory);
                string helper = Path.Combine(helperDirectory, "SCCRMonPOS.exe");
                File.Copy(_executable, helper);
                Process.Start(new ProcessStartInfo(helper, "--apply-update \"" + job + "\"") { WorkingDirectory = helperDirectory, UseShellExecute = false, CreateNoWindow = true });
            }
        }

        public void Dispose() { _http.Dispose(); }
    }

    public sealed class UpdateForm : Form
    {
        public UpdateForm(UpdateService updates, Func<bool> canRestart, Action shutdown)
        {
            var release = updates.Available;
            string envelope = updates.Envelope;
            Text = "SCCRM — มีรุ่นที่แอดมินแนะนำ";
            Font = new System.Drawing.Font("Tahoma", 10f);
            ClientSize = new System.Drawing.Size(490, 350);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false;
            var title = new Label { Bounds = new System.Drawing.Rectangle(20, 15, 450, 55), Text = "รุ่นปัจจุบัน: " + updates.CurrentVersion + "\nรุ่นที่แนะนำ: " + release.Version };
            var notes = new TextBox { Bounds = new System.Drawing.Rectangle(20, 80, 450, 150), Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Text = release.Notes ?? "" };
            var status = new Label { Bounds = new System.Drawing.Rectangle(20, 240, 450, 50), Text = "เลือกอัปเดตเมื่อสะดวก โปรแกรมสมาชิกจะปิดแล้วเปิดใหม่\nระหว่างนี้ยังใช้รุ่นปัจจุบันต่อได้" };
            var install = new Button { Text = "อัปเดตและเปิดใหม่", Bounds = new System.Drawing.Rectangle(20, 300, 260, 35) };
            var later = new Button { Text = "ภายหลัง", Bounds = new System.Drawing.Rectangle(300, 300, 170, 35), DialogResult = DialogResult.Cancel };
            var cancellation = new CancellationTokenSource(TimeSpan.FromMinutes(3));
            FormClosed += (s, e) => { cancellation.Cancel(); cancellation.Dispose(); };
            install.Click += async (s, e) => {
                if (!canRestart()) { status.Text = "กรุณาปิดหน้าสมาชิกและ QR จอลูกค้าก่อนอัปเดต"; return; }
                install.Enabled = false; later.Enabled = false; ControlBox = false;
                status.Text = "กำลังดาวน์โหลดและตรวจสอบไฟล์…";
                try
                {
                    string staged = await updates.StageAsync(release, envelope, cancellation.Token);
                    if (!canRestart()) throw new InvalidOperationException("กรุณาปิดหน้าสมาชิกและ QR ก่อน แล้วลองใหม่");
                    updates.StartHelper(staged, envelope);
                    Close(); shutdown();
                }
                catch (Exception)
                {
                    if (IsDisposed) return;
                    status.Text = "อัปเดตไม่สำเร็จ รุ่นเดิมยังใช้งานได้\nกรุณาลองใหม่หรือติดต่อแอดมิน";
                    install.Enabled = true; later.Enabled = true; ControlBox = true;
                }
            };
            Controls.AddRange(new Control[] { title, notes, status, install, later });
            CancelButton = later;
        }
    }
}
