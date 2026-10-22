using System;
using System.Data;
using System.Data.SqlClient;
using System.Text.RegularExpressions;
using SCCRMonPOS.Models;

namespace SCCRMonPOS
{
    // A SQL endpoint can serve several cash registers. Its IP/table suffix is
    // never a substitute for the branch AND FTPosCode on the receipt itself.
    internal sealed class ReceiptTerminalScope
    {
        internal string BranchCode { get; }
        internal string PosCode { get; }
        internal string Description => "สาขา " + BranchCode + " / POS " + PosCode;
        internal string FileKey => BranchCode + "-" + PosCode;
        internal ReceiptTerminalScope(string branch, string pos)
        {
            if (!Regex.IsMatch(branch ?? "", @"^[A-Za-z0-9_-]{1,40}$") || !Regex.IsMatch(pos ?? "", @"^[A-Za-z0-9_-]{1,40}$"))
                throw new InvalidOperationException("กรุณากำหนดสาขาและเลขเครื่องขายก่อนอ่านบิล");
            BranchCode = branch; PosCode = pos;
        }
        internal bool Contains(PosReceipt receipt) => receipt != null &&
            string.Equals(BranchCode, receipt.BranchCode?.Trim(), StringComparison.Ordinal) &&
            string.Equals(PosCode, receipt.PosCode?.Trim(), StringComparison.Ordinal);
        internal void Require(PosReceipt receipt)
        {
            if (!Contains(receipt)) throw new InvalidOperationException("บิลไม่ตรงกับ " + Description + " จึงบันทึกให้สมาชิกไม่ได้");
        }
        internal void AddParameters(SqlCommand command)
        {
            command.Parameters.Add("@receiptBranch", SqlDbType.VarChar, 40).Value = BranchCode;
            command.Parameters.Add("@receiptPos", SqlDbType.VarChar, 40).Value = PosCode;
        }
        internal static ReceiptTerminalScope Resolve(ApprovedDevice device, string branch, string pos)
        {
            if (device == null || device.Status != "approved") return null;
            branch = (branch ?? "").Trim(); pos = (pos ?? "").Trim();
            if (!string.IsNullOrEmpty(device.ReceiptBranchCode) || !string.IsNullOrEmpty(device.ReceiptPosCode))
            {
                if ((!string.IsNullOrEmpty(branch) && branch != device.ReceiptBranchCode) ||
                    (!string.IsNullOrEmpty(pos) && pos != device.ReceiptPosCode)) return null;
                branch = device.ReceiptBranchCode; pos = device.ReceiptPosCode;
            }
            if (!Regex.IsMatch(branch ?? "", "^[0-9]{3}$") || !Regex.IsMatch(pos ?? "", "^[0-9]{3}$")) return null;
            return new ReceiptTerminalScope(branch, pos);
        }
        internal static ReceiptTerminalScope FromConfiguration() => Resolve(DeviceAccessGuard.CurrentDevice,
            AppSettingsProvider.Get("AdaPosBranchCode", ""), AppSettingsProvider.Get("AdaPosCode", ""));
    }
}
