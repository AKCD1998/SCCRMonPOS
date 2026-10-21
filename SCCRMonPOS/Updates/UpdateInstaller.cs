using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Xml.Linq;

namespace SCCRMonPOS.Updates
{
    public static class UpdateInstaller
    {
        public static string Prepare(string target, string staged, string envelope, int processId, long processStartTicks)
        {
            string root = Path.Combine(Path.GetDirectoryName(target), "data", "updates");
            Directory.CreateDirectory(root);
            string job = Path.Combine(root, "install-" + Guid.NewGuid().ToString("N") + ".xml");
            new XDocument(new XElement("update",
                new XElement("target", Path.GetFullPath(target)), new XElement("staged", Path.GetFullPath(staged)),
                new XElement("envelope", envelope), new XElement("previousHash", UpdateRelease.HashFile(target)),
                new XElement("processId", processId), new XElement("processStartTicks", processStartTicks))).Save(job);
            return job;
        }

        // The helper is a temporary copy of this same EXE. It never kills the
        // running companion, updates AdaPos, replaces settings, or runs a shell.
        public static void Run(string jobPath)
        {
            var job = XDocument.Load(jobPath).Root;
            string target = Path.GetFullPath((string)job.Element("target"));
            string root = Path.Combine(Path.GetDirectoryName(target), "data", "updates");
            if (!string.Equals(Path.GetFileName(target), "SCCRMonPOS.exe", StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(Path.GetDirectoryName(Path.GetFullPath(jobPath)), root, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Invalid installation location.");
            string staged = Path.GetFullPath((string)job.Element("staged"));
            if (!staged.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Invalid staged file location.");
            int pid = (int)job.Element("processId");
            long ticks = (long)job.Element("processStartTicks");
            try
            {
                using (var parent = Process.GetProcessById(pid))
                {
                    if (parent.StartTime.ToUniversalTime().Ticks != ticks) throw new InvalidOperationException("Application process changed.");
                    if (!parent.WaitForExit(60000)) throw new InvalidOperationException("SCCRMonPOS ยังไม่ปิด กรุณาลองอัปเดตใหม่");
                }
            }
            catch (ArgumentException) { /* Parent has already exited. */ }
            // Mutex release follows shutdown; wait briefly for Windows handles.
            Thread.Sleep(300);
            try
            {
                Apply(target, staged, (string)job.Element("envelope"), (string)job.Element("previousHash"),
                    path => Process.Start(new ProcessStartInfo(path) { WorkingDirectory = Path.GetDirectoryName(path), UseShellExecute = true }));
            }
            catch
            {
                // After a failed attempt, reopen only the verified original EXE.
                // Do not start any unexpectedly replaced file.
                try
                {
                    if (string.Equals(UpdateRelease.HashFile(target), (string)job.Element("previousHash"), StringComparison.OrdinalIgnoreCase))
                        Process.Start(new ProcessStartInfo(target) { WorkingDirectory = Path.GetDirectoryName(target), UseShellExecute = true });
                }
                catch { }
                throw;
            }
            File.Delete(jobPath);
        }

        public static void Apply(string target, string staged, string envelope, string previousHash,
            Action<string> start, string publicKeyForTest = null)
        {
            var release = publicKeyForTest == null ? UpdateRelease.Verify(envelope) : UpdateRelease.Verify(envelope, publicKeyForTest);
            release.VerifyExecutable(staged);
            if (!string.Equals(UpdateRelease.HashFile(target), previousHash, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Installed executable changed; check again before updating.");
            string root = Path.Combine(Path.GetDirectoryName(target), "data", "updates");
            string backups = Path.Combine(root, "backups");
            Directory.CreateDirectory(backups);
            string backup = Path.Combine(backups, previousHash + "-" + Guid.NewGuid().ToString("N") + ".exe");
            string receipt = Path.Combine(root, "installed.json");
            byte[] oldReceipt = File.Exists(receipt) ? File.ReadAllBytes(receipt) : null;
            File.Replace(staged, target, backup);
            try
            {
                release.VerifyExecutable(target);
                File.WriteAllText(receipt, envelope);
                start(target);
            }
            catch
            {
                string failed = Path.Combine(root, "failed-" + Guid.NewGuid().ToString("N") + ".exe");
                File.Replace(backup, target, failed);
                if (oldReceipt != null) File.WriteAllBytes(receipt, oldReceipt);
                else if (File.Exists(receipt)) File.Delete(receipt);
                throw;
            }
        }
    }
}
