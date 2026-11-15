using System;
using System.IO;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Threading.Tasks;

namespace SCCRMonPOS
{
    [DataContract] public sealed class PreorderItem
    {
        [DataMember(Name="productCodes")] public string[] ProductCodes { get; set; }
        [DataMember(Name="productName")] public string ProductName { get; set; }
        [DataMember(Name="quantity")] public decimal? Quantity { get; set; }
        [DataMember(Name="unit")] public string Unit { get; set; }
        [DataMember(Name="sourceDescription")] public string SourceDescription { get; set; }
        [DataMember(Name="matchStatus")] public string MatchStatus { get; set; }
    }
    [DataContract] public sealed class PreorderHistory
    {
        [DataMember(Name="id")] public string Id { get; set; }
        [DataMember(Name="version")] public int Version { get; set; }
        [DataMember(Name="occurredOn")] public string OccurredOn { get; set; }
        [DataMember(Name="frequencyMonths")] public int? FrequencyMonths { get; set; }
        [DataMember(Name="notes")] public string Notes { get; set; }
        [DataMember(Name="sourceKind")] public string SourceKind { get; set; }
        [DataMember(Name="sourceReference")] public string SourceReference { get; set; }
        [DataMember(Name="sourceRow")] public int? SourceRow { get; set; }
        [DataMember(Name="createdAt")] public string CreatedAt { get; set; }
        [DataMember(Name="updatedAt")] public string UpdatedAt { get; set; }
        [DataMember(Name="items")] public PreorderItem[] Items { get; set; }
    }
    [DataContract] public sealed class PreorderBillItem
    {
        [DataMember(Name="productCode")] public string ProductCode { get; set; }
        [DataMember(Name="productName")] public string ProductName { get; set; }
        [DataMember(Name="qty")] public decimal Qty { get; set; }
        [DataMember(Name="unitName")] public string UnitName { get; set; }
        [DataMember(Name="lineTotal")] public decimal LineTotal { get; set; }
    }
    [DataContract] public sealed class PreorderBill
    {
        [DataMember(Name="id")] public string Id { get; set; }
        [DataMember(Name="branchCode")] public string BranchCode { get; set; }
        [DataMember(Name="posCode")] public string PosCode { get; set; }
        [DataMember(Name="receiptNo")] public string ReceiptNo { get; set; }
        [DataMember(Name="soldAt")] public string SoldAt { get; set; }
        [DataMember(Name="totalAmount")] public decimal TotalAmount { get; set; }
        [DataMember(Name="fingerprint")] public string Fingerprint { get; set; }
        [DataMember(Name="needsReview")] public bool NeedsReview { get; set; }
        [DataMember(Name="verificationStatus")] public string VerificationStatus { get; set; }
        [DataMember(Name="confirmedAt")] public string ConfirmedAt { get; set; }
        [DataMember(Name="items")] public PreorderBillItem[] Items { get; set; }
        [DataMember(Name="matchedItems")] public PreorderBillItem[] MatchedItems { get; set; }
        [DataMember(Name="returns")] public PreorderBillReturn[] Returns { get; set; }
    }
    [DataContract] public sealed class PreorderBillReturn
    {
        [DataMember(Name="refundDocNo")] public string RefundDocNo { get; set; }
        [DataMember(Name="refundedAt")] public string RefundedAt { get; set; }
        [DataMember(Name="refundTotal")] public decimal RefundTotal { get; set; }
    }
    [DataContract] public sealed class MemberPreorderBundle
    {
        [DataMember(Name="ok")] public bool Ok { get; set; }
        [DataMember(Name="memberId")] public string MemberId { get; set; }
        [DataMember(Name="memberName")] public string MemberName { get; set; }
        [DataMember(Name="memberCode")] public string MemberCode { get; set; }
        [DataMember(Name="records")] public PreorderHistory[] Records { get; set; }
        [DataMember(Name="confirmedBills")] public PreorderBill[] ConfirmedBills { get; set; }
        [DataMember(Name="candidates")] public PreorderBill[] Candidates { get; set; }
        [DataMember(Name="receiptsAvailable")] public bool ReceiptsAvailable { get; set; }
        [DataMember(Name="receiptMessage")] public string ReceiptMessage { get; set; }
        [DataMember(Name="hasMoreBills")] public bool HasMoreBills { get; set; }
        [DataMember(Name="nextCursor")] public string NextCursor { get; set; }
    }
    [DataContract] public sealed class PreorderCatalogItem
    {
        [DataMember(Name="productCode")] public string ProductCode { get; set; }
        [DataMember(Name="productName")] public string ProductName { get; set; }
        [DataMember(Name="unit")] public string Unit { get; set; }
        public override string ToString() { return ProductName + " — " + ProductCode; }
    }
    [DataContract] public sealed class PreorderSaveRequest
    {
        [DataMember(Name="requestId")] public string RequestId { get; set; }
        [DataMember(Name="id")] public string Id { get; set; }
        [DataMember(Name="version")] public int Version { get; set; }
        [DataMember(Name="occurredOn")] public string OccurredOn { get; set; }
        [DataMember(Name="frequencyMonths")] public int? FrequencyMonths { get; set; }
        [DataMember(Name="notes")] public string Notes { get; set; }
        [DataMember(Name="sourceReference")] public string SourceReference { get; set; }
        [DataMember(Name="items")] public PreorderItem[] Items { get; set; }
    }
    public partial class ApiClient
    {
        [DataContract] private sealed class CatalogResponse { [DataMember(Name="items")] public PreorderCatalogItem[] Items { get; set; } }
        [DataContract] private sealed class PreorderMutation { [DataMember(Name="ok")] public bool Ok { get; set; } [DataMember(Name="memberId")] public string MemberId { get; set; } }
        private static string PreorderJson<T>(T value) { using(var stream=new MemoryStream()) { new DataContractJsonSerializer(typeof(T)).WriteObject(stream,value);return Encoding.UTF8.GetString(stream.ToArray()); } }
        public async Task<MemberPreorderBundle> GetMemberPreordersAsync(string memberId, string cursor=null)
        {
            RequireValidToken();
            var result=Deserialize<MemberPreorderBundle>(await GetJsonAsync("/api/members/"+Uri.EscapeDataString(memberId)+"/preorders"+(string.IsNullOrEmpty(cursor)?"":"?cursor="+Uri.EscapeDataString(cursor)),_staffToken));
            if(result==null||!result.Ok||result.MemberId!=memberId)throw new ApiException("ข้อมูลพรีออเดอร์ไม่ตรงกับสมาชิก กรุณาโหลดใหม่");
            return result;
        }
        public async Task<PreorderCatalogItem[]> SearchPreorderProductsAsync(string query)
        {
            RequireValidToken();return Deserialize<CatalogResponse>(await GetJsonAsync("/api/members/preorders/catalog?q="+Uri.EscapeDataString(query),_staffToken))?.Items??new PreorderCatalogItem[0];
        }
        public Task SaveMemberPreorderAsync(string memberId,PreorderSaveRequest request) { return MutatePreorder(memberId,"",PreorderJson(request)); }
        public Task ConfirmPreorderBillAsync(string memberId,PreorderBill bill,string requestId,string cursor)
        {
            return MutatePreorder(memberId,"/receipt-confirmations","{\"requestId\":"+JsonStr(requestId)+",\"branchCode\":"+JsonStr(bill.BranchCode)+",\"receiptNo\":"+JsonStr(bill.ReceiptNo)+",\"fingerprint\":"+JsonStr(bill.Fingerprint)+",\"sourceCursor\":"+JsonStr(cursor)+"}");
        }
        public Task RevokePreorderBillAsync(string memberId,string linkId,string requestId,string reason)
        {
            return MutatePreorder(memberId,"/receipt-confirmations/"+Uri.EscapeDataString(linkId)+"/revoke","{\"requestId\":"+JsonStr(requestId)+",\"reason\":"+JsonStr(reason)+"}");
        }
        private async Task MutatePreorder(string memberId,string suffix,string body)
        {
            RequireValidToken();var result=Deserialize<PreorderMutation>(await PostJsonAsync("/api/members/"+Uri.EscapeDataString(memberId)+"/preorders"+suffix,body,_staffToken));
            if(result==null||!result.Ok||result.MemberId!=memberId)throw new ApiException("ยังยืนยันผลบันทึกไม่ได้ กดโหลดข้อมูลก่อนลองใหม่");
        }
    }
}
