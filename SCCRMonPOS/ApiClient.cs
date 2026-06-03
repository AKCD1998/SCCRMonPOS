using System;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using SCCRMonPOS.Models;

namespace SCCRMonPOS
{
    // ───────────────────────────────────────────────────────────────────────────
    //  Data shapes returned by the backend API
    // ───────────────────────────────────────────────────────────────────────────

    public class ApiCustomer
    {
        public string Id         { get; set; }
        public string Phone      { get; set; }
        public string FullName   { get; set; }
        public string Email      { get; set; }
        public string Tier       { get; set; }
        public bool   IsActive   { get; set; }
        public string MemberCode { get; set; }
        public int    Balance    { get; set; }
    }

    public class EarnApiResult
    {
        public string TransactionId  { get; set; }
        public int    PointsAwarded  { get; set; }
        public int    Balance        { get; set; }
        public string Tier           { get; set; }
    }

    public class ClaimTokenApiResult
    {
        public string ClaimToken { get; set; }
        public DateTime? ExpiresAt { get; set; }
    }

    // ── New loyalty flow shapes ─────────────────────────────────────────────────

    public class MemberSearchResult
    {
        public string Id            { get; set; }
        public string DisplayName   { get; set; }
        public string Phone         { get; set; }
        public string Email         { get; set; }
        public string MemberCode    { get; set; }
        public int    CurrentPoints { get; set; }
    }

    public class LoyaltyClaimItem
    {
        public string  ProductCode { get; set; }
        public string  ProductName { get; set; }
        public decimal Qty         { get; set; }
        public decimal UnitPrice   { get; set; }
        public decimal LineTotal   { get; set; }
    }

    public class LoyaltyClaimRequest
    {
        public string             ReceiptNo        { get; set; }
        public string             BranchCode       { get; set; }
        public string             CashierStaffCode { get; set; }
        public string             SoldAt           { get; set; }
        public decimal            TotalAmount      { get; set; }
        public int                PreviewPoints    { get; set; }
        public string             MemberId         { get; set; }
        public LoyaltyClaimItem[] Items            { get; set; }
    }

    public class LoyaltyClaimResponse
    {
        public bool   Ok              { get; set; }
        public string ClaimId         { get; set; }
        public string ReceiptNo       { get; set; }
        public string MemberName      { get; set; }
        public int    AwardedPoints   { get; set; }
        public int    NewPointsBalance { get; set; }
    }

    public class CreateMemberRequest
    {
        public string Name   { get; set; }
        public string Phone  { get; set; }
        public string Email  { get; set; }
        public string Sex    { get; set; }
        public string Dob    { get; set; }
        public string Remark { get; set; }
    }

    public class MemberDetail
    {
        public string Id            { get; set; }
        public string DisplayName   { get; set; }
        public string FirstName     { get; set; }
        public string LastName      { get; set; }
        public string Phone         { get; set; }
        public string Email         { get; set; }
        public string MemberCode    { get; set; }
        public int    CurrentPoints { get; set; }
        public string Sex           { get; set; }
        public string Dob           { get; set; }
        public string Remark        { get; set; }
        public string ThaiId        { get; set; }
    }

    // ── Exceptions ──────────────────────────────────────────────────────────────

    public class ApiException : Exception
    {
        public ApiException(string message) : base(message) { }
    }

    /// <summary>
    /// Thrown when the backend returns HTTP 401, or when the stored JWT
    /// has a past exp claim.  Callers should prompt re-authentication.
    /// </summary>
    public class TokenExpiredException : ApiException
    {
        public TokenExpiredException()
            : base("หมดอายุการเข้าสู่ระบบ กรุณายืนยันตัวตนพนักงานอีกครั้ง") { }
    }

    /// <summary>
    /// Thrown when a network-level failure prevents the request from
    /// reaching the server (DNS, TCP, TLS).  Safe to offer offline-queue.
    /// </summary>
    public class NetworkApiException : ApiException
    {
        public NetworkApiException(string message) : base(message) { }
    }

    // ───────────────────────────────────────────────────────────────────────────
    //  ApiClient  —  thin HTTP wrapper around the SCCRM backend
    //
    //  Uses System.Runtime.Serialization.Json (DataContractJsonSerializer)
    //  instead of the deprecated JavaScriptSerializer.
    //
    //  Retry policy: up to 3 attempts with 500 ms / 1 000 ms back-off on
    //  connection-level failures (HttpRequestException).  Timeouts and HTTP
    //  error responses are NOT retried to avoid double-earn risk.
    // ───────────────────────────────────────────────────────────────────────────

    public class ApiClient
    {
        private static readonly HttpClient _http;

        private const  int   MaxRetries = 3;
        private static readonly int[] RetryDelaysMs = { 500, 1000 };

        static ApiClient()
        {
            _http = new HttpClient();
            _http.Timeout = TimeSpan.FromSeconds(15);
            _http.DefaultRequestHeaders.Accept.Add(
                new MediaTypeWithQualityHeaderValue("application/json"));
        }

        private readonly string _baseUrl;
        private          string _staffToken;
        private          string _posApiKey;

        public ApiClient(string baseUrl)
        {
            _baseUrl = baseUrl.TrimEnd('/');
        }

        public void SetStaffToken(string token)
        {
            _staffToken = token;
        }

        public void SetPosApiKey(string key)
        {
            _posApiKey = key;
        }

        /// <summary>
        /// Returns true if the stored staff JWT has expired (or is missing).
        /// Call this before opening a form to catch stale tokens early.
        /// </summary>
        public bool IsTokenExpired()
        {
            return IsJwtExpired(_staffToken);
        }

        // ── Auth ────────────────────────────────────────────────────────────────

        /// <summary>
        /// Authenticate this POS device and return the staff token.
        /// Throws ApiException / NetworkApiException on failure.
        /// </summary>
        public async Task<string> AuthenticateStaffDeviceAsync(
            string deviceId, string deviceName, string pin)
        {
            string body =
                "{\"deviceId\":"    + JsonStr(deviceId)   + "," +
                "\"deviceName\":"   + JsonStr(deviceName) + "," +
                "\"pin\":"          + JsonStr(pin)         + "}";

            string json = await PostJsonAsync("/api/sccrm/auth/staff-device", body, token: null);
            var dto = Deserialize<StaffAuthDto>(json);
            if (string.IsNullOrEmpty(dto?.StaffToken))
                throw new ApiException("เซิร์ฟเวอร์ไม่ส่ง staff token กลับมา");
            return dto.StaffToken;
        }

        // ── Member lookup ───────────────────────────────────────────────────────

        public async Task<ApiCustomer> ResolveScanTokenAsync(string scanToken)
        {
            RequireValidToken();
            string body = "{\"token\":" + JsonStr(scanToken) + "}";
            string json = await PostJsonAsync("/api/sccrm/customers/resolve-scan-token", body, _staffToken);
            return ParseCustomerWrapper(json);
        }

        public async Task<ApiCustomer> SearchByPhoneAsync(string phone)
        {
            RequireValidToken();
            string json = await GetJsonAsync(
                "/api/sccrm/customers/search?phone=" + Uri.EscapeDataString(phone),
                _staffToken);
            return ParseCustomerWrapper(json);
        }

        public async Task<ApiCustomer> SearchByMemberCodeAsync(string memberCode)
        {
            RequireValidToken();
            string json = await GetJsonAsync(
                "/api/sccrm/customers/search?member_code=" +
                Uri.EscapeDataString(memberCode.ToUpperInvariant()),
                _staffToken);
            return ParseCustomerWrapper(json);
        }

        // ── Points ──────────────────────────────────────────────────────────────

        public async Task<EarnApiResult> EarnPointsAsync(
            string customerId, decimal billAmountThb, string receiptNo)
        {
            RequireValidToken();
            string refId = string.IsNullOrWhiteSpace(receiptNo) ? "null" : JsonStr(receiptNo);
            string body =
                "{\"customer_id\":"  + JsonStr(customerId) + "," +
                "\"amount_thb\":"    + billAmountThb.ToString("F2", CultureInfo.InvariantCulture) + "," +
                "\"reference_id\":"  + refId + "}";

            string json = await PostJsonAsync("/api/sccrm/points/earn", body, _staffToken);
            var dto = Deserialize<EarnDto>(json);
            return new EarnApiResult
            {
                TransactionId = dto?.TransactionId ?? "",
                PointsAwarded = dto?.PointsAwarded ?? 0,
                Balance       = dto?.Balance       ?? 0,
                Tier          = dto?.Tier          ?? ""
            };
        }

        public async Task<ClaimTokenApiResult> CreateSaleClaimTokenAsync(
            string branchCode, string docNo, string internalToken)
        {
            if (string.IsNullOrWhiteSpace(branchCode))
                throw new ApiException("branchCode is required.");
            if (string.IsNullOrWhiteSpace(docNo))
                throw new ApiException("docNo is required.");
            if (string.IsNullOrWhiteSpace(internalToken))
                throw new ApiException("Claim QR internal token is not configured.");

            string body =
                "{\"branch_code\":" + JsonStr(branchCode) + "," +
                "\"doc_no\":"      + JsonStr(docNo)      + "}";

            string json = await PostJsonWithInternalTokenAsync(
                "/internal/crm/pos/claim-token", body, internalToken.Trim());
            var dto = Deserialize<ClaimTokenDto>(json);
            if (string.IsNullOrWhiteSpace(dto?.ClaimToken))
                throw new ApiException("เซิร์ฟเวอร์ไม่ส่ง claim token กลับมา");

            return new ClaimTokenApiResult
            {
                ClaimToken = dto.ClaimToken,
                ExpiresAt  = ParseDateTimeOrNull(dto.ExpiresAt),
            };
        }

        // ── New loyalty flow ────────────────────────────────────────────────────

        public async Task<MemberSearchResult[]> SearchMembersAsync(string query)
        {
            RequireValidToken();
            if (string.IsNullOrWhiteSpace(query))
                return new MemberSearchResult[0];

            string json = await GetJsonAsync(
                "/api/members/search?q=" + Uri.EscapeDataString(query.Trim()),
                _staffToken);
            return ParseMemberSearchResults(json);
        }

        public async Task<MemberDetail> GetMemberAsync(string memberId)
        {
            RequireValidToken();
            if (string.IsNullOrWhiteSpace(memberId)) throw new ApiException("memberId is required.");
            string json = await GetJsonWithPosKeyAsync("/api/members/" + Uri.EscapeDataString(memberId));
            return ParseMemberFromApiResponse(json);
        }

        public async Task<MemberSearchResult> UpdateMemberAsync(string memberId, CreateMemberRequest request)
        {
            RequireValidToken();
            if (string.IsNullOrWhiteSpace(memberId)) throw new ApiException("memberId is required.");
            if (request == null) throw new ApiException("request is required.");

            var sb = new StringBuilder(512);
            sb.Append('{');
            sb.Append("\"name\":"  ).Append(JsonStr(request.Name)).Append(',');
            sb.Append("\"phone\":" ).Append(JsonStr(request.Phone)).Append(',');
            sb.Append("\"email\":" ).Append(JsonStr(request.Email)).Append(',');
            sb.Append("\"sex\":"   ).Append(JsonStr(request.Sex)).Append(',');
            sb.Append("\"dob\":"   ).Append(JsonStr(request.Dob)).Append(',');
            sb.Append("\"remark\":").Append(JsonStr(request.Remark));
            sb.Append('}');

            string json = await PutJsonWithPosKeyAsync(
                "/api/members/" + Uri.EscapeDataString(memberId), sb.ToString());
            return ParseMemberSearchResultFromApiResponse(json);
        }

        public async Task<MemberSearchResult> CreateMemberAsync(CreateMemberRequest request)
        {
            RequireValidToken();
            if (request == null) throw new ApiException("request is required.");

            var sb = new StringBuilder(512);
            sb.Append('{');
            sb.Append("\"name\":"  ).Append(JsonStr(request.Name)).Append(',');
            sb.Append("\"phone\":" ).Append(JsonStr(request.Phone)).Append(',');
            sb.Append("\"email\":" ).Append(JsonStr(request.Email)).Append(',');
            sb.Append("\"sex\":"   ).Append(JsonStr(request.Sex)).Append(',');
            sb.Append("\"dob\":"   ).Append(JsonStr(request.Dob)).Append(',');
            sb.Append("\"remark\":").Append(JsonStr(request.Remark));
            sb.Append('}');

            string json = await PostJsonAsync("/api/members", sb.ToString(), _staffToken);
            var results = ParseMemberSearchResults(json);
            if (results != null && results.Length > 0) return results[0];

            // Backend may return a single object rather than array
            var single = ParseSingleMember(json);
            if (single != null) return single;

            throw new ApiException("เซิร์ฟเวอร์ไม่ส่งข้อมูลสมาชิกกลับมา");
        }

        public async Task<LoyaltyClaimResponse> SubmitLoyaltyClaimAsync(LoyaltyClaimRequest request)
        {
            RequireValidToken();
            if (request == null) throw new ApiException("request is required.");

            string body = BuildLoyaltyClaimJson(request);
            string json = await PostJsonAsync("/api/loyalty/claims", body, _staffToken);
            return ParseLoyaltyClaimResponse(json);
        }

        public async Task RegisterSaleEventAsync(PosReceipt receipt, string internalToken)
        {
            if (receipt == null)
                throw new ApiException("receipt is required.");
            if (string.IsNullOrWhiteSpace(receipt.BranchCode))
                throw new ApiException("branchCode is required.");
            if (string.IsNullOrWhiteSpace(receipt.DocNo))
                throw new ApiException("docNo is required.");
            if (string.IsNullOrWhiteSpace(internalToken))
                throw new ApiException("Claim QR internal token is not configured.");

            string body = BuildSaleEventJson(receipt);
            await PostJsonWithInternalTokenAsync(
                "/internal/crm/pos/sale-event", body, internalToken.Trim());
        }

        // ── New loyalty flow helpers ────────────────────────────────────────────

        [DataContract] private sealed class MemberSearchDto
        {
            [DataMember(Name = "id")]            public string Id            { get; set; }
            [DataMember(Name = "displayName")]   public string DisplayName   { get; set; }
            [DataMember(Name = "phone")]         public string Phone         { get; set; }
            [DataMember(Name = "email")]         public string Email         { get; set; }
            [DataMember(Name = "memberCode")]    public string MemberCode    { get; set; }
            [DataMember(Name = "currentPoints")] public int    CurrentPoints { get; set; }
        }

        [DataContract] private sealed class LoyaltyClaimResponseDto
        {
            [DataMember(Name = "ok")]               public bool   Ok               { get; set; }
            [DataMember(Name = "claimId")]          public string ClaimId          { get; set; }
            [DataMember(Name = "receiptNo")]        public string ReceiptNo        { get; set; }
            [DataMember(Name = "awardedPoints")]    public int    AwardedPoints    { get; set; }
            [DataMember(Name = "newPointsBalance")] public int    NewPointsBalance { get; set; }
            [DataMember(Name = "member")]           public LoyaltyClaimMemberDto Member { get; set; }
        }

        [DataContract] private sealed class LoyaltyClaimMemberDto
        {
            [DataMember(Name = "id")]          public string Id          { get; set; }
            [DataMember(Name = "displayName")] public string DisplayName { get; set; }
        }

        [DataContract] private sealed class MemberDetailDto
        {
            [DataMember(Name = "id")]             public string Id            { get; set; }
            [DataMember(Name = "display_name")]   public string DisplayName   { get; set; }
            [DataMember(Name = "displayName")]    public string DisplayNameCC { get; set; }
            [DataMember(Name = "first_name")]     public string FirstName     { get; set; }
            [DataMember(Name = "last_name")]      public string LastName      { get; set; }
            [DataMember(Name = "phone")]          public string Phone         { get; set; }
            [DataMember(Name = "email")]          public string Email         { get; set; }
            [DataMember(Name = "member_code")]    public string MemberCode    { get; set; }
            [DataMember(Name = "memberCode")]     public string MemberCodeCC  { get; set; }
            [DataMember(Name = "current_points")] public int    CurrentPoints { get; set; }
            [DataMember(Name = "currentPoints")]  public int    CurrentPointsCC { get; set; }
            [DataMember(Name = "sex")]            public string Sex           { get; set; }
            [DataMember(Name = "dob")]            public string Dob           { get; set; }
            [DataMember(Name = "remark")]         public string Remark        { get; set; }
            [DataMember(Name = "thai_id")]        public string ThaiId        { get; set; }
            [DataMember(Name = "created_at")]     public string CreatedAt     { get; set; }
            [DataMember(Name = "updated_at")]     public string UpdatedAt     { get; set; }
        }

        [DataContract] private sealed class MemberApiResponseDto
        {
            [DataMember(Name = "ok")]         public bool          Ok        { get; set; }
            [DataMember(Name = "request_id")] public string        RequestId { get; set; }
            [DataMember(Name = "member")]     public MemberDetailDto Member  { get; set; }
        }

        private static MemberDetail ParseMemberDetail(string json)
        {
            try
            {
                var dto = Deserialize<MemberDetailDto>(json);
                if (dto == null) return null;
                return MapMemberDetailDto(dto);
            }
            catch { throw new ApiException("เซิร์ฟเวอร์ส่งข้อมูลสมาชิกที่ไม่ถูกต้อง"); }
        }

        private static MemberDetail ParseMemberFromApiResponse(string json)
        {
            try
            {
                var wrapped = Deserialize<MemberApiResponseDto>(json);
                if (wrapped?.Member != null) return MapMemberDetailDto(wrapped.Member);
                var dto = Deserialize<MemberDetailDto>(json);
                if (dto != null) return MapMemberDetailDto(dto);
                return null;
            }
            catch { throw new ApiException("เซิร์ฟเวอร์ส่งข้อมูลสมาชิกที่ไม่ถูกต้อง"); }
        }

        private static MemberSearchResult ParseMemberSearchResultFromApiResponse(string json)
        {
            try
            {
                var wrapped = Deserialize<MemberApiResponseDto>(json);
                if (wrapped?.Member != null) return MapMemberSearchResult(wrapped.Member);
                var single = ParseSingleMember(json);
                if (single != null) return single;
                var arr = ParseMemberSearchResults(json);
                if (arr != null && arr.Length > 0) return arr[0];
                throw new ApiException("เซิร์ฟเวอร์ไม่ส่งข้อมูลสมาชิกกลับมา");
            }
            catch (ApiException) { throw; }
            catch { throw new ApiException("เซิร์ฟเวอร์ส่งข้อมูลสมาชิกที่ไม่ถูกต้อง"); }
        }

        private static MemberDetail MapMemberDetailDto(MemberDetailDto m)
        {
            string display = m.DisplayName ?? m.DisplayNameCC
                             ?? ((m.FirstName ?? "") + " " + (m.LastName ?? "")).Trim();
            return new MemberDetail
            {
                Id            = m.Id,
                DisplayName   = display,
                FirstName     = m.FirstName,
                LastName      = m.LastName,
                Phone         = m.Phone,
                Email         = m.Email,
                MemberCode    = m.MemberCode ?? m.MemberCodeCC,
                CurrentPoints = m.CurrentPoints > 0 ? m.CurrentPoints : m.CurrentPointsCC,
                Sex           = m.Sex,
                Dob           = m.Dob,
                Remark        = m.Remark,
                ThaiId        = m.ThaiId
            };
        }

        private static MemberSearchResult MapMemberSearchResult(MemberDetailDto m)
        {
            string display = m.DisplayName ?? m.DisplayNameCC
                             ?? ((m.FirstName ?? "") + " " + (m.LastName ?? "")).Trim();
            return new MemberSearchResult
            {
                Id            = m.Id,
                DisplayName   = display,
                Phone         = m.Phone,
                Email         = m.Email,
                MemberCode    = m.MemberCode ?? m.MemberCodeCC,
                CurrentPoints = m.CurrentPoints > 0 ? m.CurrentPoints : m.CurrentPointsCC
            };
        }

        private static MemberSearchResult ParseSingleMember(string json)
        {
            try
            {
                var dto = Deserialize<MemberSearchDto>(json);
                if (dto == null || string.IsNullOrEmpty(dto.Id)) return null;
                return new MemberSearchResult
                {
                    Id            = dto.Id,
                    DisplayName   = dto.DisplayName,
                    Phone         = dto.Phone,
                    Email         = dto.Email,
                    MemberCode    = dto.MemberCode,
                    CurrentPoints = dto.CurrentPoints
                };
            }
            catch { return null; }
        }

        private static MemberSearchResult[] ParseMemberSearchResults(string json)
        {
            if (string.IsNullOrEmpty(json)) return new MemberSearchResult[0];
            try
            {
                var ser = new DataContractJsonSerializer(typeof(MemberSearchDto[]));
                using (var ms = new MemoryStream(Encoding.UTF8.GetBytes(json)))
                {
                    var dtos = ser.ReadObject(ms) as MemberSearchDto[];
                    if (dtos == null) return new MemberSearchResult[0];
                    var results = new MemberSearchResult[dtos.Length];
                    for (int i = 0; i < dtos.Length; i++)
                    {
                        results[i] = new MemberSearchResult
                        {
                            Id            = dtos[i].Id,
                            DisplayName   = dtos[i].DisplayName,
                            Phone         = dtos[i].Phone,
                            Email         = dtos[i].Email,
                            MemberCode    = dtos[i].MemberCode,
                            CurrentPoints = dtos[i].CurrentPoints
                        };
                    }
                    return results;
                }
            }
            catch { throw new ApiException("เซิร์ฟเวอร์ส่งข้อมูลสมาชิกที่ไม่ถูกต้อง"); }
        }

        private static LoyaltyClaimResponse ParseLoyaltyClaimResponse(string json)
        {
            var dto = Deserialize<LoyaltyClaimResponseDto>(json);
            if (dto == null) throw new ApiException("เซิร์ฟเวอร์ไม่ส่งผลลัพธ์การสะสมแต้มกลับมา");
            return new LoyaltyClaimResponse
            {
                Ok               = dto.Ok,
                ClaimId          = dto.ClaimId,
                ReceiptNo        = dto.ReceiptNo,
                MemberName       = dto.Member?.DisplayName ?? "",
                AwardedPoints    = dto.AwardedPoints,
                NewPointsBalance = dto.NewPointsBalance
            };
        }

        private static string BuildLoyaltyClaimJson(LoyaltyClaimRequest r)
        {
            var sb = new StringBuilder(2048);
            sb.Append('{');
            sb.Append("\"receiptNo\":").Append(JsonStr(r.ReceiptNo)).Append(',');
            sb.Append("\"branchCode\":").Append(JsonStr(r.BranchCode)).Append(',');
            sb.Append("\"cashierStaffCode\":").Append(JsonStr(r.CashierStaffCode)).Append(',');
            sb.Append("\"soldAt\":").Append(JsonStr(r.SoldAt)).Append(',');
            sb.Append("\"totalAmount\":").Append(JsonNum(r.TotalAmount)).Append(',');
            sb.Append("\"previewPoints\":").Append(r.PreviewPoints).Append(',');
            sb.Append("\"memberId\":").Append(JsonStr(r.MemberId)).Append(',');
            sb.Append("\"items\":[");
            if (r.Items != null)
            {
                for (int i = 0; i < r.Items.Length; i++)
                {
                    var item = r.Items[i];
                    if (i > 0) sb.Append(',');
                    sb.Append('{');
                    sb.Append("\"productCode\":").Append(JsonStr(item.ProductCode)).Append(',');
                    sb.Append("\"productName\":").Append(JsonStr(item.ProductName)).Append(',');
                    sb.Append("\"qty\":").Append(JsonNum(item.Qty)).Append(',');
                    sb.Append("\"unitPrice\":").Append(JsonNum(item.UnitPrice)).Append(',');
                    sb.Append("\"lineTotal\":").Append(JsonNum(item.LineTotal));
                    sb.Append('}');
                }
            }
            sb.Append("]}");
            return sb.ToString();
        }

        // ── Internal DTOs (private — consumers use ApiCustomer / EarnApiResult) ──

        [DataContract]
        private sealed class StaffAuthDto
        {
            [DataMember(Name = "staffToken")] public string StaffToken { get; set; }
        }

        [DataContract]
        private sealed class CustomerWrapperDto
        {
            [DataMember(Name = "customer")] public CustomerDto Customer { get; set; }
        }

        [DataContract]
        private sealed class CustomerDto
        {
            [DataMember(Name = "id")]          public string Id         { get; set; }
            [DataMember(Name = "phone")]       public string Phone      { get; set; }
            [DataMember(Name = "full_name")]   public string FullName   { get; set; }
            [DataMember(Name = "email")]       public string Email      { get; set; }
            [DataMember(Name = "tier")]        public string Tier       { get; set; }
            [DataMember(Name = "is_active")]   public bool   IsActive   { get; set; }
            [DataMember(Name = "member_code")] public string MemberCode { get; set; }
            [DataMember(Name = "balance")]     public int    Balance    { get; set; }
        }

        [DataContract]
        private sealed class EarnDto
        {
            [DataMember(Name = "transactionId")]  public string TransactionId  { get; set; }
            [DataMember(Name = "pointsAwarded")]  public int    PointsAwarded  { get; set; }
            [DataMember(Name = "balance")]        public int    Balance        { get; set; }
            [DataMember(Name = "tier")]           public string Tier           { get; set; }
        }

        [DataContract]
        private sealed class ClaimTokenDto
        {
            [DataMember(Name = "claim_token")] public string ClaimToken { get; set; }
            [DataMember(Name = "expires_at")]  public string ExpiresAt  { get; set; }
        }

        [DataContract]
        private sealed class ErrorDto
        {
            [DataMember(Name = "error")] public string Error { get; set; }
        }

        // ── Internal helpers ────────────────────────────────────────────────────

        private void RequireValidToken()
        {
            if (string.IsNullOrEmpty(_staffToken))
                throw new ApiException("ยังไม่ได้ยืนยันตัวตนพนักงาน กรุณาลองใหม่อีกครั้ง");
            if (IsJwtExpired(_staffToken))
                throw new TokenExpiredException();
        }

        private static ApiCustomer ParseCustomerWrapper(string json)
        {
            var wrapper = Deserialize<CustomerWrapperDto>(json);
            if (wrapper?.Customer == null) return null;
            var c = wrapper.Customer;
            return new ApiCustomer
            {
                Id         = c.Id,
                Phone      = c.Phone,
                FullName   = c.FullName,
                Email      = c.Email,
                Tier       = c.Tier,
                IsActive   = c.IsActive,
                MemberCode = c.MemberCode,
                Balance    = c.Balance
            };
        }

        // ── HTTP layer with retry ───────────────────────────────────────────────

        private Task<string> GetJsonAsync(string path, string token)
        {
            return SendWithRetryAsync(() =>
            {
                var req = new HttpRequestMessage(HttpMethod.Get, _baseUrl + path);
                if (!string.IsNullOrEmpty(token))
                    req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                return req;
            });
        }

        private Task<string> PostJsonAsync(string path, string jsonBody, string token)
        {
            return SendWithRetryAsync(() =>
            {
                var req = new HttpRequestMessage(HttpMethod.Post, _baseUrl + path)
                {
                    Content = new StringContent(jsonBody, Encoding.UTF8, "application/json")
                };
                if (!string.IsNullOrEmpty(token))
                    req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                return req;
            });
        }

        private Task<string> PutJsonAsync(string path, string jsonBody, string token)
        {
            return SendWithRetryAsync(() =>
            {
                var req = new HttpRequestMessage(HttpMethod.Put, _baseUrl + path)
                {
                    Content = new StringContent(jsonBody, Encoding.UTF8, "application/json")
                };
                if (!string.IsNullOrEmpty(token))
                    req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                return req;
            });
        }

        private Task<string> GetJsonWithPosKeyAsync(string path)
        {
            return SendWithRetryAsync(() =>
            {
                var req = new HttpRequestMessage(HttpMethod.Get, _baseUrl + path);
                if (!string.IsNullOrEmpty(_posApiKey))
                    req.Headers.Add("x-pos-api-key", _posApiKey);
                return req;
            });
        }

        private Task<string> PutJsonWithPosKeyAsync(string path, string jsonBody)
        {
            return SendWithRetryAsync(() =>
            {
                var req = new HttpRequestMessage(HttpMethod.Put, _baseUrl + path)
                {
                    Content = new StringContent(jsonBody, Encoding.UTF8, "application/json")
                };
                if (!string.IsNullOrEmpty(_posApiKey))
                    req.Headers.Add("x-pos-api-key", _posApiKey);
                return req;
            });
        }

        private Task<string> PostJsonWithInternalTokenAsync(string path, string jsonBody, string internalToken)
        {
            return SendWithRetryAsync(() =>
            {
                var req = new HttpRequestMessage(HttpMethod.Post, _baseUrl + path)
                {
                    Content = new StringContent(jsonBody, Encoding.UTF8, "application/json")
                };
                req.Headers.Add("x-internal-token", internalToken);
                return req;
            });
        }

        /// <summary>
        /// Sends the request built by <paramref name="buildRequest"/>, retrying
        /// up to MaxRetries times on connection-level failures only.
        /// Timeouts and HTTP 4xx/5xx are not retried.
        /// </summary>
        private static async Task<string> SendWithRetryAsync(Func<HttpRequestMessage> buildRequest)
        {
            for (int attempt = 0; attempt < MaxRetries; attempt++)
            {
                HttpResponseMessage response;
                try
                {
                    response = await _http.SendAsync(buildRequest());
                }
                catch (TaskCanceledException)
                {
                    // Timeout — server state is unknown; do NOT retry to avoid double-earn.
                    throw new ApiException("เซิร์ฟเวอร์ไม่ตอบสนองภายในเวลาที่กำหนด กรุณาลองใหม่ด้วยตนเอง");
                }
                catch (HttpRequestException ex)
                {
                    // Connection-level failure — server never received the request.
                    bool hasMoreRetries = attempt < MaxRetries - 1;
                    if (hasMoreRetries)
                    {
                        await Task.Delay(RetryDelaysMs[attempt]);
                        continue;
                    }
                    throw new NetworkApiException(
                        "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาตรวจสอบอินเทอร์เน็ต (" + ex.Message + ")");
                }

                string text = await response.Content.ReadAsStringAsync();

                if (response.StatusCode == HttpStatusCode.Unauthorized)
                    throw new TokenExpiredException();

                if (!response.IsSuccessStatusCode)
                {
                    string msg = TryExtractError(text)
                               ?? "ข้อผิดพลาดจากเซิร์ฟเวอร์ (HTTP " + (int)response.StatusCode + ")";
                    throw new ApiException(msg);
                }

                return text;
            }

            // Unreachable: loop always returns or throws before exhausting attempts.
            throw new NetworkApiException("ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้หลังจากลองหลายครั้ง");
        }

        // ── JSON helpers ────────────────────────────────────────────────────────

        private static T Deserialize<T>(string json) where T : class
        {
            if (string.IsNullOrEmpty(json)) return null;
            try
            {
                var ser = new DataContractJsonSerializer(typeof(T));
                using (var ms = new MemoryStream(Encoding.UTF8.GetBytes(json)))
                    return (T)ser.ReadObject(ms);
            }
            catch
            {
                throw new ApiException("เซิร์ฟเวอร์ส่งข้อมูลที่ไม่ถูกต้อง");
            }
        }

        private static string TryExtractError(string json)
        {
            try
            {
                var dto = Deserialize<ErrorDto>(json);
                return string.IsNullOrEmpty(dto?.Error) ? null : dto.Error;
            }
            catch { return null; }
        }


        private static DateTime? ParseDateTimeOrNull(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return null;
            DateTime parsed;
            if (DateTime.TryParse(
                raw,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal,
                out parsed))
            {
                return parsed;
            }
            return null;
        }

        private static string BuildSaleEventJson(PosReceipt receipt)
        {
            var sb = new StringBuilder(1024);
            sb.Append('{');
            sb.Append("\"branch_code\":").Append(JsonStr(receipt.BranchCode)).Append(',');
            sb.Append("\"doc_no\":").Append(JsonStr(receipt.DocNo)).Append(',');
            sb.Append("\"pos_code\":").Append(JsonStr(receipt.PosCode)).Append(',');
            sb.Append("\"grand_total\":").Append(JsonNum(receipt.GrandTotal)).Append(',');
            sb.Append("\"tender_code\":").Append(JsonStr(receipt.PaymentCode)).Append(',');
            sb.Append("\"tender_ref\":").Append(JsonStr(receipt.PromptPayRef)).Append(',');
            sb.Append("\"inserted_at\":").Append(JsonStr(FormatInsertedAt(receipt))).Append(',');
            sb.Append("\"items\":[");

            for (int i = 0; i < receipt.Items.Count; i++)
            {
                PosReceiptItem item = receipt.Items[i];
                if (i > 0) sb.Append(',');
                sb.Append('{');
                sb.Append("\"product_code\":").Append(JsonStr(item.ProductCode)).Append(',');
                sb.Append("\"qty\":").Append(JsonNum(item.Qty)).Append(',');
                sb.Append("\"net_amt\":").Append(JsonNum(item.NetAmount));
                sb.Append('}');
            }

            sb.Append(']');
            sb.Append('}');
            return sb.ToString();
        }

        private static string FormatInsertedAt(PosReceipt receipt)
        {
            DateTime local = receipt.InsertDate.Date;

            TimeSpan time;
            if (TimeSpan.TryParse(receipt.InsertTime ?? "", out time))
                local = local.Add(time);
            else if (TimeSpan.TryParse(receipt.DocTime ?? "", out time))
                local = local.Add(time);
            else
                local = local.Add(receipt.DocDate.TimeOfDay);

            local = DateTime.SpecifyKind(local, DateTimeKind.Unspecified);
            var offset = new DateTimeOffset(local, TimeZoneInfo.Local.GetUtcOffset(local));
            return offset.ToString("yyyy-MM-ddTHH:mm:sszzz", CultureInfo.InvariantCulture);
        }

        private static string JsonNum(decimal value)
        {
            return value.ToString("0.##", CultureInfo.InvariantCulture);
        }

        /// <summary>Returns a JSON string literal (with surrounding quotes) for value.</summary>
        private static string JsonStr(string value)
        {
            if (value == null) return "null";
            var sb = new StringBuilder(value.Length + 2);
            sb.Append('"');
            foreach (char c in value)
            {
                switch (c)
                {
                    case '"':  sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n");  break;
                    case '\r': sb.Append("\\r");  break;
                    case '\t': sb.Append("\\t");  break;
                    default:
                        if (c < 0x20)
                            sb.AppendFormat("\\u{0:x4}", (int)c);
                        else
                            sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        // ── JWT expiry detection ────────────────────────────────────────────────

        /// <summary>
        /// Decodes the JWT payload and checks whether the exp claim is in the past.
        /// Returns true  (expired) if the token is null/empty, or if its exp claim
        /// is in the past (with a 30-second clock-skew buffer).
        /// Returns false (valid)   if the token is opaque (no dots — not a JWT),
        /// has no exp claim, or cannot be decoded.  The server will reject a revoked
        /// opaque token with HTTP 401, which triggers TokenExpiredException normally.
        /// </summary>
        private static bool IsJwtExpired(string token)
        {
            if (string.IsNullOrEmpty(token)) return true;
            try
            {
                string[] parts = token.Split('.');
                if (parts.Length < 2) return false; // opaque token (no dots) — not a JWT; assume valid, server will reject if revoked

                // base64url → standard base64
                string b64 = parts[1].Replace('-', '+').Replace('_', '/');
                switch (b64.Length % 4)
                {
                    case 2: b64 += "=="; break;
                    case 3: b64 += "=";  break;
                }

                string payload = Encoding.UTF8.GetString(Convert.FromBase64String(b64));

                var m = Regex.Match(payload, "\"exp\"\\s*:\\s*(\\d+)");
                if (!m.Success) return false;   // no exp claim → treat as valid

                long expUnix = long.Parse(m.Groups[1].Value);
                long nowUnix = (long)(DateTime.UtcNow -
                               new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds;

                return nowUnix >= expUnix - 30; // 30 s buffer for clock skew
            }
            catch { return false; }  // can't decode → don't block operation
        }
    }
}
