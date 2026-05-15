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

        public ApiClient(string baseUrl)
        {
            _baseUrl = baseUrl.TrimEnd('/');
        }

        public void SetStaffToken(string token)
        {
            _staffToken = token;
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
