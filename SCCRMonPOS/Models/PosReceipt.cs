using System;
using System.Collections.Generic;
using System.Runtime.Serialization;

namespace SCCRMonPOS.Models
{
    [DataContract]
    public class PosReceipt
    {
        [DataMember] public string DocNo { get; set; }
        [DataMember] public string DocType { get; set; }
        [DataMember] public bool IsReturn { get; set; }
        [DataMember] public string BranchCode { get; set; }
        [DataMember] public string PosCode { get; set; }
        [DataMember] public string CashierCode { get; set; }
        [DataMember] public DateTime DocDate { get; set; }
        [DataMember] public string DocTime { get; set; }
        [DataMember] public DateTime InsertDate { get; set; }
        [DataMember] public string InsertTime { get; set; }
        [DataMember] public decimal GrandTotal { get; set; }
        [DataMember] public decimal Discount { get; set; }
        [DataMember] public decimal CashAmount { get; set; }
        [DataMember] public decimal ChangeGiven { get; set; }
        [DataMember] public string PaymentCode { get; set; }
        [DataMember] public string PaymentName { get; set; }
        [DataMember] public string PromptPayRef { get; set; }
        [DataMember] public string OriginalDocNo { get; set; }
        [DataMember] public string HeaderTable { get; set; }
        [DataMember] public string DetailTable { get; set; }
        [DataMember] public string PaymentTable { get; set; }
        [DataMember] public List<PosReceiptItem> Items { get; set; }

        public PosReceipt()
        {
            Items = new List<PosReceiptItem>();
        }
    }

    [DataContract]
    public class PosReceiptItem
    {
        [DataMember] public int Seq { get; set; }
        [DataMember] public string ProductCode { get; set; }
        [DataMember] public string ProductName { get; set; }
        [DataMember] public string Barcode { get; set; }
        [DataMember] public decimal Qty { get; set; }
        [DataMember] public decimal UnitPrice { get; set; }
        [DataMember] public decimal NetAmount { get; set; }
        [DataMember] public decimal LineDiscount { get; set; }
        [DataMember] public string PromotionCode { get; set; }
    }
}
