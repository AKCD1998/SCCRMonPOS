using System;
using System.IO;
using System.Text;
using SCCRMonPOS.Models;

namespace SCCRMonPOS
{
    /// <summary>
    /// Appends transaction records to a JSON Lines file (one JSON object per line).
    /// The file is append-only and human-readable — no deserialization required for phase 1.
    /// </summary>
    public class TransactionRepository
    {
        public string LogFilePath { get; private set; }

        private static readonly Random _rng = new Random();

        // ────────────────────────────────────────────────────────────────────
        public TransactionRepository(string dataFolder)
        {
            Directory.CreateDirectory(dataFolder);
            LogFilePath = Path.Combine(dataFolder, "transactions.jsonl");
        }

        // ── Public API ───────────────────────────────────────────────────────

        /// <summary>
        /// Appends one transaction record to the log.
        /// Throws IOException / UnauthorizedAccessException on disk failure — caller must handle.
        /// </summary>
        public void Append(TransactionLog log)
        {
            string json = Serialize(log);
            // AppendAllText creates the file if it doesn't exist
            File.AppendAllText(LogFilePath, json + Environment.NewLine, Encoding.UTF8);
        }

        /// <summary>
        /// Generates a unique transaction ID in the format:
        /// LOCAL-{machineName}-{yyyyMMddHHmmss}-{rand4}
        /// </summary>
        public static string GenerateTransactionId()
        {
            string machine = SanitizeName(Environment.MachineName);
            string ts      = DateTime.Now.ToString("yyyyMMddHHmmss");
            string rand    = _rng.Next(1000, 9999).ToString();
            return "LOCAL-" + machine + "-" + ts + "-" + rand;
        }

        // ── Private helpers ──────────────────────────────────────────────────

        /// <summary>
        /// Hand-rolls a compact JSON object string.
        /// Avoids any external serializer dependency; straightforward for this fixed schema.
        /// </summary>
        private static string Serialize(TransactionLog t)
        {
            var sb = new StringBuilder();
            sb.Append('{');
            AppendStr(sb, "transactionId",   t.TransactionId);   sb.Append(',');
            AppendStr(sb, "transactionType", t.TransactionType);  sb.Append(',');
            AppendStr(sb, "memberToken",     t.MemberToken);      sb.Append(',');
            AppendStr(sb, "memberName",      t.MemberName);       sb.Append(',');
            AppendStr(sb, "receiptNo",       t.ReceiptNo ?? "");  sb.Append(',');
            AppendNum(sb, "billAmount",      t.BillAmount.ToString("F2")); sb.Append(',');
            AppendNum(sb, "earnedPoints",    t.EarnedPoints.ToString());   sb.Append(',');
            AppendNum(sb, "pointsBefore",    t.PointsBefore.ToString());   sb.Append(',');
            AppendNum(sb, "pointsAfter",     t.PointsAfter.ToString());    sb.Append(',');
            AppendStr(sb, "createdAt",       t.CreatedAt.ToString("yyyy-MM-dd HH:mm:ss")); sb.Append(',');
            AppendStr(sb, "posMachineName",  t.PosMachineName);
            sb.Append('}');
            return sb.ToString();
        }

        private static void AppendStr(StringBuilder sb, string key, string value)
        {
            sb.Append('"').Append(JsonEscape(key)).Append("\":\"")
              .Append(JsonEscape(value ?? "")).Append('"');
        }

        private static void AppendNum(StringBuilder sb, string key, string numericValue)
        {
            sb.Append('"').Append(JsonEscape(key)).Append("\":").Append(numericValue);
        }

        /// <summary>Escapes special characters for JSON string values.</summary>
        private static string JsonEscape(string s)
        {
            if (string.IsNullOrEmpty(s)) return s;
            return s.Replace("\\", "\\\\")
                    .Replace("\"", "\\\"")
                    .Replace("\r", "\\r")
                    .Replace("\n", "\\n")
                    .Replace("\t", "\\t");
        }

        /// <summary>Strips characters that are invalid in a transaction ID segment.</summary>
        private static string SanitizeName(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return "UNKNOWN";
            var sb = new StringBuilder();
            foreach (char c in name)
                if (char.IsLetterOrDigit(c) || c == '-') sb.Append(c);
            return sb.Length > 0 ? sb.ToString().ToUpperInvariant() : "UNKNOWN";
        }
    }
}
