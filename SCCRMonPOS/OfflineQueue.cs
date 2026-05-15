using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace SCCRMonPOS
{
    /// <summary>
    /// File-backed queue for earn requests that could not be submitted due to a
    /// network failure.  One JSON object per line in data/offline-queue.jsonl.
    ///
    /// Usage:
    ///   • Enqueue()    — call when EarnPointsAsync throws NetworkApiException
    ///   • DrainAsync() — call on startup (or manually) to re-submit pending items
    ///   • Count        — number of items waiting; use to update tray tooltip
    /// </summary>
    public class OfflineQueue
    {
        private readonly string _filePath;
        private readonly object _fileLock = new object();

        public OfflineQueue(string dataFolder)
        {
            Directory.CreateDirectory(dataFolder);
            _filePath = Path.Combine(dataFolder, "offline-queue.jsonl");
        }

        // ── Public API ────────────────────────────────────────────────────────

        public int Count
        {
            get
            {
                if (!File.Exists(_filePath)) return 0;
                try
                {
                    int n = 0;
                    foreach (string line in File.ReadAllLines(_filePath, Encoding.UTF8))
                        if (!string.IsNullOrWhiteSpace(line)) n++;
                    return n;
                }
                catch { return 0; }
            }
        }

        /// <summary>Appends one earn request to the offline queue.</summary>
        public void Enqueue(string customerId, decimal billAmountThb, string receiptNo,
                            string memberName, string memberCode)
        {
            string line = Serialize(new QueueItem
            {
                CustomerId    = customerId    ?? "",
                BillAmountThb = billAmountThb,
                ReceiptNo     = receiptNo     ?? "",
                MemberName    = memberName    ?? "",
                MemberCode    = memberCode    ?? "",
                QueuedAt      = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")
            });
            lock (_fileLock)
            {
                File.AppendAllText(_filePath, line + Environment.NewLine, Encoding.UTF8);
            }
        }

        /// <summary>
        /// Re-submits every queued item against the live API.
        /// Items that succeed are removed from the queue.
        /// Items that fail are written back so they can be retried later.
        /// Returns (submitted, failed).
        /// </summary>
        public async Task<DrainResult> DrainAsync(ApiClient api)
        {
            if (!File.Exists(_filePath))
                return new DrainResult(0, 0);

            List<QueueItem> items;
            lock (_fileLock) { items = LoadAll(); }

            if (items.Count == 0)
                return new DrainResult(0, 0);

            var remaining  = new List<string>();
            int submitted  = 0;
            int failed     = 0;

            foreach (var item in items)
            {
                try
                {
                    await api.EarnPointsAsync(item.CustomerId, item.BillAmountThb, item.ReceiptNo);
                    submitted++;
                }
                catch (TokenExpiredException)
                {
                    // Token expired mid-drain — stop now; remainder stays queued.
                    remaining.Add(Serialize(item));
                    failed++;
                    // Re-enqueue any items we haven't processed yet
                    int processed = submitted + failed - 1;
                    for (int i = processed + 1; i < items.Count; i++)
                        remaining.Add(Serialize(items[i]));
                    break;
                }
                catch
                {
                    remaining.Add(Serialize(item));
                    failed++;
                }
            }

            lock (_fileLock)
            {
                if (remaining.Count == 0)
                {
                    if (File.Exists(_filePath)) File.Delete(_filePath);
                }
                else
                {
                    File.WriteAllLines(_filePath, remaining, Encoding.UTF8);
                }
            }

            return new DrainResult(submitted, failed);
        }

        // ── Serialization (hand-rolled — no external dependency) ─────────────

        private static string Serialize(QueueItem i)
        {
            return
                "{\"customerId\":"    + Q(i.CustomerId)    + "," +
                "\"billAmountThb\":"  + i.BillAmountThb.ToString("F2", CultureInfo.InvariantCulture) + "," +
                "\"receiptNo\":"      + Q(i.ReceiptNo)     + "," +
                "\"memberName\":"     + Q(i.MemberName)    + "," +
                "\"memberCode\":"     + Q(i.MemberCode)    + "," +
                "\"queuedAt\":"       + Q(i.QueuedAt)      + "}";
        }

        private static QueueItem TryDeserialize(string line)
        {
            try
            {
                return new QueueItem
                {
                    CustomerId    = Str(line, "customerId"),
                    BillAmountThb = decimal.Parse(Num(line, "billAmountThb"),
                                        CultureInfo.InvariantCulture),
                    ReceiptNo     = Str(line, "receiptNo"),
                    MemberName    = Str(line, "memberName"),
                    MemberCode    = Str(line, "memberCode"),
                    QueuedAt      = Str(line, "queuedAt")
                };
            }
            catch { return null; }
        }

        private static string Str(string json, string key)
        {
            var m = Regex.Match(json,
                "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            if (!m.Success) return "";
            return m.Groups[1].Value
                     .Replace("\\\"", "\"")
                     .Replace("\\\\", "\\");
        }

        private static string Num(string json, string key)
        {
            var m = Regex.Match(json,
                "\"" + Regex.Escape(key) + "\"\\s*:\\s*([0-9.]+)");
            return m.Success ? m.Groups[1].Value : "0";
        }

        /// <summary>JSON-encodes a string value including surrounding quotes.</summary>
        private static string Q(string value)
        {
            if (value == null) return "null";
            var sb = new StringBuilder(value.Length + 2);
            sb.Append('"');
            foreach (char c in value)
            {
                if (c == '"')       sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c == '\n') sb.Append("\\n");
                else if (c == '\r') sb.Append("\\r");
                else                sb.Append(c);
            }
            sb.Append('"');
            return sb.ToString();
        }

        private List<QueueItem> LoadAll()
        {
            var result = new List<QueueItem>();
            if (!File.Exists(_filePath)) return result;
            foreach (string line in File.ReadAllLines(_filePath, Encoding.UTF8))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                var item = TryDeserialize(line);
                if (item != null) result.Add(item);
            }
            return result;
        }

        // ── Types ─────────────────────────────────────────────────────────────

        private class QueueItem
        {
            public string  CustomerId    { get; set; }
            public decimal BillAmountThb { get; set; }
            public string  ReceiptNo     { get; set; }
            public string  MemberName    { get; set; }
            public string  MemberCode    { get; set; }
            public string  QueuedAt      { get; set; }
        }
    }

    public struct DrainResult
    {
        public int Submitted { get; }
        public int Failed    { get; }

        public DrainResult(int submitted, int failed)
        {
            Submitted = submitted;
            Failed    = failed;
        }
    }
}
