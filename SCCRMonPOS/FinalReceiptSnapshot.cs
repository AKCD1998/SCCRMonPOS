using System;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using SCCRMonPOS.Models;

namespace SCCRMonPOS
{
    // Read the paid header, all details and all tenders twice. Ada owns prices
    // and promotions; never reconstruct the payable total from list prices.
    internal static class FinalReceiptSnapshot
    {
        internal static bool IsPaid(PosReceipt r)
        {
            return r != null && r.DocType == "1" && r.PaidStatus == "3" && r.DocumentStatus == "1"
                && r.GrandTotal > 0 && r.Items != null && r.Items.Count > 0
                && r.Payments != null && r.Payments.Count > 0
                && Math.Abs(r.Payments.Sum(p => p.NetAmount) - r.GrandTotal) < 0.005m;
        }

        internal static string Fingerprint(PosReceipt r)
        {
            if (!IsPaid(r)) return null;
            var s = new StringBuilder();
            Action<object> add = value => { string v = Convert.ToString(value, CultureInfo.InvariantCulture) ?? ""; s.Append(v.Length).Append(':').Append(v).Append('|'); };
            foreach (object v in new object[] {r.BranchCode,r.PosCode,r.DocNo,r.DocType,r.DocDate.Ticks,r.DocTime,
                r.PaidStatus,r.DocumentStatus,r.GrandTotal,r.Discount,r.Rounding,r.CashAmount,r.ChangeGiven}) add(v);
            add(r.Items.Count);
            foreach (var i in r.Items.OrderBy(i => i.Seq))
                foreach (object v in new object[] {i.Seq,i.ProductCode,i.ProductName,i.Barcode,i.UnitCode,i.UnitName,
                    i.Qty,i.UnitPrice,i.NetAmount,i.LineDiscount,i.PromotionCode}) add(v);
            add(r.Payments.Count);
            foreach (var p in r.Payments.OrderBy(p => p.Seq))
                foreach (object v in new object[] {p.Seq,p.Code,p.Amount,p.NetAmount,p.Change}) add(v);
            using (var hash = SHA256.Create()) return Convert.ToBase64String(hash.ComputeHash(Encoding.UTF8.GetBytes(s.ToString())));
        }

        internal static PosReceipt ReadStable(Func<PosReceipt> read, Action pause, int attempts = 4)
        {
            string previous = null;
            for (int n = 0; n < attempts; n++)
            {
                var receipt = read();
                string current = Fingerprint(receipt);
                if (current != null && current == previous) { receipt.FinalSnapshotVerified = true; return receipt; }
                previous = current;
                if (n + 1 < attempts) pause();
            }
            return null;
        }
    }
}
