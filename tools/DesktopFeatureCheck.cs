using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using SCCRMonPOS;
using SCCRMonPOS.Updates;

internal static class DesktopFeatureCheck
{
    private static int checks;
    private static string stage = "start";
    private static void Check(bool value) { if (!value) throw new InvalidOperationException("Check failed: " + stage); checks++; }
    private static void Reject(Action action) { bool rejected = false; try { action(); } catch { rejected = true; } Check(rejected); }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "--live-channel")
            {
                LiveChannel(args[1]).GetAwaiter().GetResult();
            }
            else if (args.Length == 2 && args[0] == "--verify-release")
            {
                stage = "admin-signature";
                var release = UpdateRelease.Verify(File.ReadAllText(args[1]));
                release.VerifyExecutable(Path.Combine(Path.GetDirectoryName(args[1]), "SCCRMonPOS.exe"));
                Check(true);
            }
            else
            {
                var root = Path.Combine(Path.GetTempPath(), "sccrm-desktop-check-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(root);
                // Keep the test directory for inspection; every fixture is synthetic.
                using (var key = new RSACryptoServiceProvider(2048))
                {
                    key.PersistKeyInCsp = false;
                    Contracts(root, key);
                    Polling(root, key).GetAwaiter().GetResult();
                }
                RenderPreviews();
                MemberSelection();
                CashierWindowSwitching();
            }
            Console.WriteLine("{\"ok\":true,\"checks\":" + checks + ",\"stage\":\"" + stage + "\"}"); return 0;
        }
        catch (Exception error) { Console.WriteLine("{\"ok\":false,\"stage\":\"" + stage + "\",\"type\":\"" + error.GetType().Name + "\"}"); return 1; }
    }

    private static UpdateRelease Metadata(string path, string version = "1.2.0")
    {
        return new UpdateRelease { SchemaVersion = 1, DeviceAccessVersion = 1, ReleaseId = "test-" + version, Version = version,
            DownloadUrl = "https://github.com/AKCD1998/SCCRMonPOS/releases/download/test-" + version + "/SCCRMonPOS.exe",
            Sha256 = UpdateRelease.HashFile(path), Size = new FileInfo(path).Length, Notes = "Synthetic test", SourceCommit = new string('a', 40), PublishedAt = DateTime.UtcNow.ToString("o") };
    }

    // Reads the real public channel and explicitly downloads its signed asset
    // into an isolated fixture. Never installs or launches the companion.
    private static async Task LiveChannel(string previousExe)
    {
        stage = "live-public-channel";
        string root = Path.Combine(Path.GetTempPath(),"sccrm-channel-check-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        string target = Path.Combine(root,"SCCRMonPOS.exe"); File.Copy(previousExe,target);
        string previousHash = UpdateRelease.HashFile(target);
        using(var service=new UpdateService(target))
        {
            await service.CheckAsync(); Check(service.Available != null);
            Check(UpdateRelease.HashFile(target)==previousHash);
            string downloaded=await service.StageAsync(service.Available,service.Envelope,CancellationToken.None);
            service.Available.VerifyExecutable(downloaded); Check(true);
            Check(UpdateRelease.HashFile(target)==previousHash);
            Console.WriteLine("{\"channelLive\":true,\"version\":\""+service.Available.Version+"\",\"signatureAndDownloadVerified\":true,\"installedOrLaunched\":false}");
        }
    }
    private static string Sign(UpdateRelease release, RSACryptoServiceProvider key)
    {
        byte[] bytes;
        using (var stream = new MemoryStream()) { new DataContractJsonSerializer(typeof(UpdateRelease)).WriteObject(stream, release); bytes = stream.ToArray(); }
        return "{\"payload\":\"" + Convert.ToBase64String(bytes) + "\",\"signature\":\"" + Convert.ToBase64String(key.SignData(bytes, CryptoConfig.MapNameToOID("SHA256"))) + "\"}";
    }
    private static void Contracts(string root, RSACryptoServiceProvider key)
    {
        var pub = key.ToXmlString(false);
        var oldBytes = Enumerable.Repeat((byte)31, 2048).ToArray(); var newBytes = Enumerable.Repeat((byte)99, 3072).ToArray();
        string target = Path.Combine(root, "SCCRMonPOS.exe"), stageFile = Path.Combine(root, "staged.exe");
        File.WriteAllBytes(target, oldBytes); File.WriteAllBytes(stageFile, newBytes);
        var metadata = Metadata(stageFile); string manifest = Sign(metadata, key);
        stage = "signatures-and-metadata";
        Check(UpdateRelease.Verify(manifest, pub).Version == "1.2.0");
        Reject(() => UpdateRelease.Verify(manifest.Replace("payload\":\"", "payload\":\"AAAA"), pub));
        using (var other = new RSACryptoServiceProvider()) { other.PersistKeyInCsp = false; Reject(() => UpdateRelease.Verify(manifest, other.ToXmlString(false))); }
        var invalid = Metadata(stageFile); invalid.DownloadUrl = invalid.DownloadUrl.Replace("https:", "http:"); Reject(() => UpdateRelease.Verify(Sign(invalid,key), pub));
        invalid.DownloadUrl = "https://github.com/other/repo/releases/download/x/SCCRMonPOS.exe"; Reject(() => UpdateRelease.Verify(Sign(invalid,key), pub));
        invalid = Metadata(stageFile); invalid.Size = 30 * 1024 * 1024; Reject(() => UpdateRelease.Verify(Sign(invalid,key), pub));
        invalid = Metadata(stageFile); invalid.Sha256 = new string('z',64); Reject(() => UpdateRelease.Verify(Sign(invalid,key), pub));
        stage = "atomic-install-preserves-config";
        string config = Path.Combine(root, "SCCRMonPOS.exe.config"), data = Path.Combine(root, "data");
        Directory.CreateDirectory(data); File.WriteAllText(config, "synthetic configuration"); File.WriteAllText(Path.Combine(data,"staff-config.json"),"synthetic session");
        string oldHash = UpdateRelease.HashFile(target); bool started = false;
        UpdateInstaller.Apply(target, stageFile, manifest, oldHash, path => { started = path == target; }, pub);
        Check(started && File.ReadAllBytes(target).SequenceEqual(newBytes));
        Check(File.ReadAllText(config) == "synthetic configuration" && File.ReadAllText(Path.Combine(data,"staff-config.json")) == "synthetic session");
        Check(Directory.GetFiles(Path.Combine(data,"updates","backups")).Any(p => File.ReadAllBytes(p).SequenceEqual(oldBytes)));
        string receipt = Path.Combine(data,"updates","installed.json"); Check(File.ReadAllText(receipt) == manifest);

        stage = "explicit-rollback-to-older-release";
        File.WriteAllBytes(stageFile, oldBytes); var rollback = Sign(Metadata(stageFile,"1.1.0"),key);
        UpdateInstaller.Apply(target,stageFile,rollback,UpdateRelease.HashFile(target),p=>{},pub);
        Check(File.ReadAllBytes(target).SequenceEqual(oldBytes)); Check(File.ReadAllText(receipt) == rollback);

        stage = "failed-launch-restores-prior-exe-and-receipt";
        File.WriteAllBytes(stageFile,newBytes);
        Reject(() => UpdateInstaller.Apply(target,stageFile,manifest,UpdateRelease.HashFile(target),p=>{throw new Win32Exception("synthetic launch failure");},pub));
        Check(File.ReadAllBytes(target).SequenceEqual(oldBytes) && File.ReadAllText(receipt) == rollback);
        stage = "tampered-files-do-not-change-installation";
        File.WriteAllBytes(stageFile,newBytes);
        Reject(() => UpdateInstaller.Apply(target,stageFile,manifest,new string('0',64),p=>{},pub));
        Check(File.ReadAllBytes(target).SequenceEqual(oldBytes));
        File.AppendAllText(stageFile,"tampered");
        Reject(() => UpdateInstaller.Apply(target,stageFile,manifest,UpdateRelease.HashFile(target),p=>{},pub));
        Check(File.ReadAllBytes(target).SequenceEqual(oldBytes));
    }

    private sealed class FixtureHttp : HttpMessageHandler
    {
        public string Manifest; public byte[] Binary; public bool Missing; public int AssetRequests;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
        {
            bool asset = request.RequestUri.Host == "github.com";
            if (asset) AssetRequests++;
            return Task.FromResult(new HttpResponseMessage(!asset && Missing ? HttpStatusCode.NotFound : HttpStatusCode.OK) {
                RequestMessage = request, Content = asset ? (HttpContent)new ByteArrayContent(Binary) : new StringContent(Manifest)
            });
        }
    }
    private static async Task Polling(string root, RSACryptoServiceProvider key)
    {
        stage = "two-devices-notify-without-forced-download";
        string source = Path.Combine(root,"candidate.exe"); File.WriteAllBytes(source,Enumerable.Repeat((byte)7,4096).ToArray());
        string manifest = Sign(Metadata(source),key), pub = key.ToXmlString(false);
        var handlers = new List<FixtureHttp>();
        var services = new List<UpdateService>();
        try
        {
            for (int index = 0; index < 2; index++)
            {
                string device = Path.Combine(root,"device-"+index); Directory.CreateDirectory(device);
                string exe = Path.Combine(device,"SCCRMonPOS.exe"); File.Copy(typeof(UpdateRelease).Assembly.Location,exe);
                var handler = new FixtureHttp { Manifest = manifest, Binary = File.ReadAllBytes(source) }; handlers.Add(handler);
                var service = new UpdateService(exe,"https://fixture.invalid/stable.json",new HttpClient(handler),j=>UpdateRelease.Verify(j,pub)); services.Add(service);
                int notices = 0; service.UpdateAvailable += r => notices++;
                await service.CheckAsync(); await service.CheckAsync();
                Check(service.Available != null && notices == 1 && handler.AssetRequests == 0);
                Check(File.ReadAllBytes(exe).SequenceEqual(File.ReadAllBytes(typeof(UpdateRelease).Assembly.Location)));
            }
            stage = "explicit-download-only-on-selected-device";
            string staged = await services[0].StageAsync(services[0].Available,services[0].Envelope,CancellationToken.None);
            Check(File.ReadAllBytes(staged).SequenceEqual(File.ReadAllBytes(source)));
            Check(handlers[0].AssetRequests == 1 && handlers[1].AssetRequests == 0);
            stage = "unavailable-channel-keeps-old-version-usable";
            handlers[1].Missing = true; await services[1].CheckAsync(); Check(services[1].Available == null && handlers[1].AssetRequests == 0);
            stage = "bad-download-is-rejected";
            handlers[0].Binary = Enumerable.Repeat((byte)1,4096).ToArray();
            bool rejected = false; try { await services[0].StageAsync(services[0].Available,services[0].Envelope,CancellationToken.None); } catch (CryptographicException) { rejected = true; }
            Check(rejected);
        }
        finally { foreach(var service in services) service.Dispose(); }
    }

    private static void RenderPreviews()
    {
        stage = "customer-sign-and-nonactivating-mouse-transparent-overlay";
        string output = Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"previews"); Directory.CreateDirectory(output);
        using (var form = new CustomerQrForm { ClientSize = new Size(800,600) })
        using (var image = new Bitmap(800,600))
        {
            form.DrawToBitmap(image,new Rectangle(0,0,800,600)); image.Save(Path.Combine(output,"customer-qr.png"));
            var cp = (CreateParams)typeof(CustomerQrForm).GetProperty("CreateParams",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(form);
            Check((cp.ExStyle & 0x08000000) != 0);
        }
        using (var image = new Bitmap(1000,700))
        using (var graphics = Graphics.FromImage(image))
        {
            graphics.Clear(Color.FromArgb(242,244,248));
            using (var font = new Font("Tahoma",18)) graphics.DrawString("ตัวอย่างจอแคชเชียร์ — พื้นที่นี้ยังคลิกและพิมพ์ได้",font,Brushes.DimGray,90,160);
            var rectangles = new[]{new Rectangle(0,0,1000,16),new Rectangle(0,684,1000,16),new Rectangle(0,16,16,668),new Rectangle(984,16,16,668)};
            for(int side=0;side<4;side++) using(var glow=CashierQrOverlay.DrawGlow(rectangles[side].Size,side,0)) graphics.DrawImage(glow,rectangles[side]);
            var buttonType = typeof(CashierQrOverlay).GetNestedType("CloseQrButton",BindingFlags.NonPublic);
            using(var button=(Form)Activator.CreateInstance(buttonType,new object[]{(Action)(()=>{})}))
            using(var bitmap=new Bitmap(310,38))
            {
                button.ClientSize=new Size(310,38);button.DrawToBitmap(bitmap,new Rectangle(0,0,310,38));graphics.DrawImage(bitmap,345,8);
            }
            image.Save(Path.Combine(output,"cashier-glow.png"));
            var edgeType=typeof(CashierQrOverlay).GetNestedType("GlowEdge",BindingFlags.NonPublic);
            using(var edge=(Form)Activator.CreateInstance(edgeType,new object[]{rectangles[0],0}))
            {
                var cp=(CreateParams)edgeType.GetProperty("CreateParams",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(edge);
                Check((cp.ExStyle & 0x08080020)==0x08080020);
            }
        }
        using(var first=CashierQrOverlay.DrawGlow(new Size(300,16),0,0))
        using(var next=CashierQrOverlay.DrawGlow(new Size(300,16),0,Math.PI))
        { Check(first.GetPixel(0,0).A > first.GetPixel(0,15).A); Check(first.GetPixel(20,0)!=next.GetPixel(20,0)); }
        stage = "layered-window-api-offscreen";
        using (var overlay = new CashierQrOverlay(new Rectangle(-12000,-12000,800,600),()=>{}))
        { Application.DoEvents(); Check(true); }
    }

    private static void MemberSelection()
    {
        stage = "first-selected-row-retains-unavailable-points";
        var receipt = new SCCRMonPOS.Models.PosReceipt { GrandTotal = 100m,
            Items = new List<SCCRMonPOS.Models.PosReceiptItem> { new SCCRMonPOS.Models.PosReceiptItem { ProductName = "Synthetic item", NetAmount = 100m } } };
        using (var display = new CustomerDisplayController(Path.Combine(Path.GetTempPath(),"sccrm-selection-test")))
        using (var form = new MemberClaimForm(new ApiClient("http://127.0.0.1:1"),null,25,"synthetic",receipt,display))
        {
            var grid = (DataGridView)typeof(MemberClaimForm).GetField("_dgvResults",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(form);
            var handle = grid.Handle;
            typeof(MemberClaimForm).GetMethod("AddMemberRow",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(form,new object[] {
                new MemberSearchResult { Id="synthetic",DisplayName="Synthetic",PointsAvailable=false,PharmacyMedRecordAvailable=false }
            });
            grid.Rows[0].Selected = true;
            var selected = (MemberSearchResult)typeof(MemberClaimForm).GetField("_selectedMember",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(form);
            Check(selected != null && !selected.PointsAvailable);
            Check(!(bool)typeof(MemberClaimForm).GetMethod("CanConfirm",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(form,null));
        }
    }

    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);

    // Use real offscreen HWNDs on a deliberately blocked UI thread. A normal
    // window on another UI thread must cover the cashier and its owned dialogs
    // without asking the blocked thread to process an activation/close message.
    private static void CashierWindowSwitching()
    {
        stage = "blocked-cashier-does-not-cover-other-apps";
        using (var ready = new ManualResetEvent(false))
        using (var release = new ManualResetEvent(false))
        {
            IntPtr[] windows = null;
            Exception error = null;
            bool mainCanMinimize = false;
            var worker = new Thread(() =>
            {
                try
                {
                    using (var main = new MemberClaimForm())
                    using (var login = new StaffLoginForm())
                    using (var create = new NewMemberForm(new ApiClient("http://127.0.0.1:1")))
                    using (var edit = new NewMemberForm(new ApiClient("http://127.0.0.1:1"), new MemberDetail { Id = "synthetic" }))
                    using (var medical = new PharmacyMedRecordForm("synthetic"))
                    {
                        create.Owner = main; edit.Owner = main; medical.Owner = create;
                        var forms = new Form[] { main, login, create, edit, medical };
                        windows = forms.Select(form => {
                            form.StartPosition = FormStartPosition.Manual;
                            form.Location = new Point(-12000, -12000);
                            ShowWindow(form.Handle, 4); // SW_SHOWNOACTIVATE
                            return form.Handle;
                        }).ToArray();
                        mainCanMinimize = main.ShowInTaskbar && main.MinimizeBox;
                        main.WindowState = FormWindowState.Minimized;
                        mainCanMinimize &= IsIconic(main.Handle);
                        main.WindowState = FormWindowState.Normal;
                        ready.Set();
                        if (!release.WaitOne(15000)) throw new TimeoutException("Cashier test was not released.");
                    }
                }
                catch (Exception ex) { error = ex; ready.Set(); }
            }) { IsBackground = true };
            worker.SetApartmentState(ApartmentState.STA);
            worker.Start();
            try
            {
                Check(ready.WaitOne(10000));
                if (error != null) throw error;
                Check(mainCanMinimize);
                using (var otherApp = new Form { StartPosition = FormStartPosition.Manual, Location = new Point(-12000,-12000) })
                {
                    ShowWindow(otherApp.Handle, 4);
                    Check(SetWindowPos(otherApp.Handle, IntPtr.Zero, 0, 0, 0, 0, 0x13)); // TOP, NOACTIVATE/NOMOVE/NOSIZE
                    foreach (var window in windows)
                    {
                        Check((GetWindowLong(window, -20) & 0x8) == 0); // no WS_EX_TOPMOST
                        bool covered = false;
                        var previous = window;
                        for (int i = 0; i < 1000 && previous != IntPtr.Zero; i++)
                        {
                            previous = GetWindow(previous, 3); // GW_HWNDPREV
                            if (previous == otherApp.Handle) { covered = true; break; }
                        }
                        Check(covered);
                    }
                }
            }
            finally { release.Set(); worker.Join(10000); }
            if (error != null) throw error;
        }
    }
}
