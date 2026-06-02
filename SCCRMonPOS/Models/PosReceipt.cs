using System;
using System.Collections.Generic;

namespace SCCRMonPOS.Models
{
    public class PosReceipt
    {
        public string   DocNo         { get; set; }  // e.g. S2605005002-0000850
        public string   DocType       { get; set; }  // "1" = sale, "9" = return
        public bool     IsReturn      { get; set; }
        public string   BranchCode    { get; set; }
        public string   PosCode       { get; set; }  // "001", "002"
        public string   CashierCode   { get; set; }
        public DateTime DocDate       { get; set; }
        public string   DocTime       { get; set; }  // "HH:MM:SS" from AdaPos
        public DateTime InsertDate    { get; set; }  // watermark — midnight of sale date
        public string   InsertTime    { get; set; }  // watermark — "HH:MM:SS"
        public decimal  GrandTotal    { get; set; }  // total paid after all discounts
        public decimal  Discount      { get; set; }  // header-level discount
        public decimal  CashAmount    { get; set; }  // FCShdMnyCsh
        public decimal  ChangeGiven   { get; set; }  // FCShdChn
        public string   PaymentCode   { get; set; }  // "001"=cash "013"=PromptPay
        public string   PaymentName   { get; set; }
        public string   PromptPayRef  { get; set; }  // QR payment reference if PromptPay
        public string   OriginalDocNo { get; set; }  // returns only: the sale being reversed

        public List<PosReceiptItem> Items { get; set; } = new List<PosReceiptItem>();
    }

    public class PosReceiptItem
    {
        public int     Seq           { get; set; }
        public string  ProductCode   { get; set; }
        public string  ProductName   { get; set; }
        public string  Barcode       { get; set; }
        public decimal Qty           { get; set; }
        public decimal UnitPrice     { get; set; }  // FCSdtSetPrice — actual charged price
        public decimal NetAmount     { get; set; }  // FCSdtNet — use for points calculation
        public decimal LineDiscount  { get; set; }
        public string  PromotionCode { get; set; }
    }
}
