using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Threading.Tasks;
using System.Threading;
using System.Windows.Forms;

namespace SCCRMonPOS
{
    [DataContract]
    public sealed class CentralPointQuote
    {
        [DataMember(Name = "ok")] public bool Ok { get; set; }
        [DataMember(Name = "awardedPoints")] public int AwardedPoints { get; set; }
        [DataMember(Name = "basePoints")] public int BasePoints { get; set; }
        [DataMember(Name = "revision")] public string Revision { get; set; }
    }

    // Business data is read from the API independently of the update channel.
    public static class CentralPromotions
    {
        private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(12) };
        private static string BaseUrl { get { return AppSettingsProvider.Get("ApiBaseUrl", "https://sc-official-website.onrender.com").TrimEnd('/'); } }
        public static string PortalUrl(string branchCode = null)
        {
            return BaseUrl + "/sccrm/promotions" + (string.IsNullOrWhiteSpace(branchCode) ? "" : "?branchCode=" + Uri.EscapeDataString(branchCode));
        }
        public static void OpenPortal(string branchCode = null)
        {
            try { Process.Start(new ProcessStartInfo(PortalUrl(branchCode)) { UseShellExecute = true }); }
            catch { MessageBox.Show("เปิดเบราว์เซอร์ไม่สำเร็จ กรุณาเปิด " + PortalUrl(branchCode), "SCCRM"); }
        }
        public static async Task<CentralPointQuote> QuoteAsync(decimal amount, string branchCode)
        {
            string url = BaseUrl + "/api/sccrm/promotions/quote?amount=" + amount.ToString("F2", CultureInfo.InvariantCulture) + "&branchCode=" + Uri.EscapeDataString(branchCode ?? "");
            using (var request = new HttpRequestMessage(HttpMethod.Get, url))
            using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(12)))
            {
                request.Headers.CacheControl = new System.Net.Http.Headers.CacheControlHeaderValue { NoCache = true, NoStore = true };
                using (var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false))
                {
                    response.EnsureSuccessStatusCode();
                    if (response.Content.Headers.ContentLength > 262144) throw new InvalidDataException("Promotion response too large.");
                    using (var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                    using (var buffer = new MemoryStream())
                    {
                        var bytes = new byte[4096]; int read;
                        while ((read = await stream.ReadAsync(bytes, 0, bytes.Length, timeout.Token).ConfigureAwait(false)) > 0)
                        {
                            if (buffer.Length + read > 262144) throw new InvalidDataException("Promotion response too large.");
                            buffer.Write(bytes, 0, read);
                        }
                        buffer.Position = 0;
                        var result = (CentralPointQuote)new DataContractJsonSerializer(typeof(CentralPointQuote)).ReadObject(buffer);
                        if (result == null || !result.Ok || result.AwardedPoints < 0 || string.IsNullOrWhiteSpace(result.Revision)) throw new InvalidDataException("Invalid promotion quote.");
                        return result;
                    }
                }
            }
        }
    }
}
