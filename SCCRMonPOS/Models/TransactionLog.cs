using System;

namespace SCCRMonPOS.Models
{
    /// <summary>
    /// Represents one point-collection transaction written to transactions.jsonl.
    /// Intentionally a plain POCO — serialised manually so the log stays human-readable.
    /// </summary>
    public class TransactionLog
    {
        /// <summary>Format: LOCAL-{machineName}-{yyyyMMddHHmmss}-{rand4}</summary>
        public string TransactionId { get; set; }

        /// <summary>"POINT_COLLECT" for phase 1.</summary>
        public string TransactionType { get; set; }

        public string MemberToken { get; set; }
        public string MemberName { get; set; }

        /// <summary>Optional receipt number entered by cashier.</summary>
        public string ReceiptNo { get; set; }

        public decimal BillAmount { get; set; }
        public int EarnedPoints { get; set; }
        public int PointsBefore { get; set; }
        public int PointsAfter { get; set; }

        public DateTime CreatedAt { get; set; }
        public string PosMachineName { get; set; }
    }
}
