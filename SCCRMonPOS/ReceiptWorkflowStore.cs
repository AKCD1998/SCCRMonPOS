using System;
using System.IO;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using SCCRMonPOS.Models;

namespace SCCRMonPOS
{
    [DataContract]
    public sealed class ReceiptWatermark
    {
        [DataMember] public DateTime InsertDate { get; set; }
        [DataMember] public string InsertTime   { get; set; }
        [DataMember] public string DocNo        { get; set; }

        public static ReceiptWatermark Create(DateTime insertDate, string insertTime, string docNo)
        {
            return new ReceiptWatermark
            {
                InsertDate = insertDate.Date,
                InsertTime = (insertTime ?? "").Trim(),
                DocNo      = (docNo ?? "").Trim()
            };
        }

        public static ReceiptWatermark FromReceipt(PosReceipt receipt)
        {
            if (receipt == null) return null;
            return Create(receipt.InsertDate, receipt.InsertTime, receipt.DocNo);
        }

        public string Describe()
        {
            return InsertDate.ToString("yyyy-MM-dd") + " " + (InsertTime ?? "") + " | doc=" + (DocNo ?? "");
        }
    }

    public sealed class ReceiptWatermarkStore
    {
        private readonly string _filePath;

        public ReceiptWatermarkStore(string dataFolder)
        {
            Directory.CreateDirectory(dataFolder);
            _filePath = Path.Combine(dataFolder, "receipt-watermark.json");
        }

        public ReceiptWatermark Load()
        {
            if (!File.Exists(_filePath)) return null;
            try
            {
                string json = File.ReadAllText(_filePath, Encoding.UTF8);
                return Deserialize<ReceiptWatermark>(json);
            }
            catch { return null; }
        }

        public void Save(ReceiptWatermark watermark)
        {
            if (watermark == null) return;
            File.WriteAllText(_filePath, Serialize(watermark), Encoding.UTF8);
        }

        private static string Serialize<T>(T value)
        {
            var ser = new DataContractJsonSerializer(typeof(T));
            using (var ms = new MemoryStream())
            {
                ser.WriteObject(ms, value);
                return Encoding.UTF8.GetString(ms.ToArray());
            }
        }

        private static T Deserialize<T>(string json) where T : class
        {
            if (string.IsNullOrWhiteSpace(json)) return null;
            var ser = new DataContractJsonSerializer(typeof(T));
            using (var ms = new MemoryStream(Encoding.UTF8.GetBytes(json)))
                return ser.ReadObject(ms) as T;
        }
    }
}
