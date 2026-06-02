using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Threading.Tasks;

namespace SCCRMonPOS
{
    public class ProductEligibilityLookupException : Exception
    {
        public ProductEligibilityLookupException(string message) : base(message) { }
    }

    public class ProductEligibilityNotFoundException : ProductEligibilityLookupException
    {
        public ProductEligibilityNotFoundException()
            : base("ไม่พบข้อมูลสินค้าในฐานข้อมูลคัดกรอง") { }
    }

    public class ProductEligibilityResult
    {
        public string MatchedBy    { get; set; }
        public string CompanyCode  { get; set; }
        public string Barcode      { get; set; }
        public string DisplayName  { get; set; }
        public string CategoryName { get; set; }
        public string ProductKind  { get; set; }
        public bool   Eligible     { get; set; }
        public string Reason       { get; set; }
    }

    public class ProductEligibilityClient
    {
        private static readonly HttpClient _http = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(10),
        };

        private readonly string _baseUrl;
        private readonly string _apiKey;

        public ProductEligibilityClient(string baseUrl, string apiKey)
        {
            _baseUrl = (baseUrl ?? "").Trim().TrimEnd('/');
            _apiKey  = (apiKey  ?? "").Trim();
        }

        public bool IsConfigured
        {
            get { return !string.IsNullOrEmpty(_baseUrl) && !string.IsNullOrEmpty(_apiKey); }
        }

        public async Task<ProductEligibilityResult> LookupAsync(string code)
        {
            string trimmed = (code ?? "").Trim();
            if (string.IsNullOrEmpty(trimmed))
                throw new ProductEligibilityLookupException("กรุณากรอกรหัสสินค้า หรือ บาร์โค้ด");
            if (!IsConfigured)
                throw new ProductEligibilityLookupException("ยังไม่ได้ตั้งค่าระบบคัดกรองสินค้า");

            ProductEligibilityResult byBarcode = await TryLookupAsync("barcode", trimmed);
            if (byBarcode != null) return byBarcode;

            ProductEligibilityResult byCompanyCode = await TryLookupAsync("company_code", trimmed);
            if (byCompanyCode != null) return byCompanyCode;

            throw new ProductEligibilityNotFoundException();
        }

        private async Task<ProductEligibilityResult> TryLookupAsync(string key, string value)
        {
            string url = _baseUrl + "/api/loyalty/products/eligibility?" +
                         key + "=" + Uri.EscapeDataString(value);

            using (var req = new HttpRequestMessage(HttpMethod.Get, url))
            {
                req.Headers.Add("x-pos-api-key", _apiKey);

                HttpResponseMessage response;
                try
                {
                    response = await _http.SendAsync(req);
                }
                catch (TaskCanceledException)
                {
                    throw new ProductEligibilityLookupException("ระบบคัดกรองสินค้าไม่ตอบสนองภายในเวลาที่กำหนด");
                }
                catch (HttpRequestException ex)
                {
                    throw new ProductEligibilityLookupException("ไม่สามารถเชื่อมต่อระบบคัดกรองสินค้าได้ (" + ex.Message + ")");
                }

                string text = await response.Content.ReadAsStringAsync();
                if (response.StatusCode == HttpStatusCode.NotFound)
                    return null;
                if (response.StatusCode == HttpStatusCode.Unauthorized)
                    throw new ProductEligibilityLookupException("รหัสเชื่อมต่อระบบคัดกรองสินค้าไม่ถูกต้อง");
                if (!response.IsSuccessStatusCode)
                    throw new ProductEligibilityLookupException(TryExtractError(text) ?? "ระบบคัดกรองสินค้าขัดข้อง");

                LoyaltyEligibilityResponse dto = Deserialize<LoyaltyEligibilityResponse>(text);
                if (dto == null || dto.Product == null || dto.Loyalty == null)
                    throw new ProductEligibilityLookupException("ระบบคัดกรองสินค้าส่งข้อมูลไม่ถูกต้อง");

                return new ProductEligibilityResult
                {
                    MatchedBy    = dto.MatchedBy ?? "",
                    CompanyCode  = dto.Product.CompanyCode ?? "",
                    Barcode      = dto.Product.Barcode ?? "",
                    DisplayName  = dto.Product.DisplayName ?? "",
                    CategoryName = dto.Product.CategoryName ?? "",
                    ProductKind  = dto.Product.ProductKind ?? "",
                    Eligible     = dto.Loyalty.Eligible,
                    Reason       = dto.Loyalty.Reason ?? "",
                };
            }
        }

        [DataContract]
        private sealed class LoyaltyEligibilityResponse
        {
            [DataMember(Name = "matched_by")] public string MatchedBy { get; set; }
            [DataMember(Name = "product")]    public ProductDto Product { get; set; }
            [DataMember(Name = "loyalty")]    public LoyaltyDto Loyalty { get; set; }
        }

        [DataContract]
        private sealed class ProductDto
        {
            [DataMember(Name = "company_code")]  public string CompanyCode  { get; set; }
            [DataMember(Name = "barcode")]       public string Barcode      { get; set; }
            [DataMember(Name = "display_name")]  public string DisplayName  { get; set; }
            [DataMember(Name = "category_name")] public string CategoryName { get; set; }
            [DataMember(Name = "product_kind")]  public string ProductKind  { get; set; }
        }

        [DataContract]
        private sealed class LoyaltyDto
        {
            [DataMember(Name = "eligible")] public bool Eligible { get; set; }
            [DataMember(Name = "reason")]   public string Reason { get; set; }
        }

        [DataContract]
        private sealed class ErrorDto
        {
            [DataMember(Name = "error")] public string Error { get; set; }
        }

        private static T Deserialize<T>(string json) where T : class
        {
            if (string.IsNullOrEmpty(json)) return null;
            var ser = new DataContractJsonSerializer(typeof(T));
            using (var ms = new MemoryStream(Encoding.UTF8.GetBytes(json)))
                return (T)ser.ReadObject(ms);
        }

        private static string TryExtractError(string json)
        {
            try
            {
                ErrorDto dto = Deserialize<ErrorDto>(json);
                return dto == null ? null : dto.Error;
            }
            catch
            {
                return null;
            }
        }
    }
}
