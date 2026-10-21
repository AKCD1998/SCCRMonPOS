using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Threading.Tasks;
using SCCRMonPOS;

// Contract checks and an opt-in live check using the exact desktop ApiClient.
// Credentials arrive over stdin only and are never persisted or printed.
internal static class MemberApiCheck
{
    private static string stage = "start";
    private static int checks;

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "--live") Live().GetAwaiter().GetResult();
            else Offline();
            return 0;
        }
        catch (Exception error)
        {
            Console.WriteLine("{\"ok\":false,\"stage\":\"" + stage + "\",\"type\":\"" + error.GetType().Name + "\"}");
            return 1;
        }
    }

    private static void Check(bool condition)
    {
        if (!condition) throw new InvalidOperationException("Contract check failed");
        checks++;
    }

    private static T Parse<T>(string method, string json)
    {
        return (T)typeof(ApiClient).GetMethod(method, BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, new object[] { json });
    }

    private static void Offline()
    {
        stage = "offline-contracts";
        string flat = "{\"id\":\"fixture\",\"displayName\":\"สมาชิกจำลอง\",\"phone\":\"0990000001\",\"memberCode\":\"SCM-TEST\",\"currentPoints\":0,\"pointsAvailable\":false,\"pharmacyMedRecordAvailable\":false}";
        foreach (string json in new[] { flat, "{\"ok\":true,\"member\":" + flat + "}", "[" + flat + "]" })
        {
            var member = Parse<MemberSearchResult>("ParseMemberSearchResultFromApiResponse", json);
            Check(member.Id == "fixture" && member.DisplayName == "สมาชิกจำลอง");
            Check(!member.PointsAvailable && !member.PharmacyMedRecordAvailable);
        }
        var detail = Parse<MemberDetail>("ParseMemberFromApiResponse", flat);
        Check(detail.MemberCode == "SCM-TEST" && !detail.PointsAvailable);
        var array = Parse<MemberSearchResult[]>("ParseMemberSearchResults", "[" + flat + "]");
        Check(array.Length == 1 && !array[0].PointsAvailable);
        var legacy = Parse<MemberSearchResult>("ParseMemberSearchResultFromApiResponse", "{\"id\":\"legacy\",\"currentPoints\":17}");
        Check(legacy.PointsAvailable && legacy.PharmacyMedRecordAvailable && legacy.CurrentPoints == 17);
        Check(Parse<string>("TryExtractError", "{\"message\":\"Phone already registered\"}") == "Phone already registered");
        Check(Parse<string>("TryExtractError", "{\"error\":\"Invalid phone\"}") == "Invalid phone");
        Console.WriteLine("{\"ok\":true,\"mode\":\"offline\",\"checks\":" + checks + "}");
    }

    [DataContract]
    private sealed class Input
    {
        [DataMember] public string BaseUrl { get; set; }
        [DataMember] public string StaffToken { get; set; }
        [DataMember] public string PosKey { get; set; }
        [DataMember] public string QrId { get; set; }
        [DataMember] public string QrPhone { get; set; }
        [DataMember] public string PosPhone { get; set; }
        [DataMember] public string PosEditedPhone { get; set; }
        [DataMember] public string Marker { get; set; }
    }

    private static async Task ExpectRejected(Func<Task<MemberSearchResult>> action)
    {
        bool rejected = false;
        try { await action(); }
        catch (ApiException) { rejected = true; }
        Check(rejected);
    }

    private static async Task Live()
    {
        stage = "read-input";
        var input = (Input)new DataContractJsonSerializer(typeof(Input)).ReadObject(Console.OpenStandardInput());
        Check(input.BaseUrl == "https://sc-official-website.onrender.com" || input.BaseUrl.StartsWith("http://127.0.0.1:", StringComparison.Ordinal));
        Check(input.Marker.StartsWith("POS-QR-TEST-", StringComparison.Ordinal));
        var api = new ApiClient(input.BaseUrl);
        api.SetStaffToken(input.StaffToken);
        api.SetPosApiKey(input.PosKey);

        stage = "search-qr";
        var qrSearch = await api.SearchMembersAsync(input.QrPhone);
        Check(qrSearch.Any(m => m.Id == input.QrId));
        var qr = await api.GetMemberAsync(input.QrId);
        Check(qr.Id == input.QrId && !qr.PointsAvailable && !qr.PharmacyMedRecordAvailable);
        Check((await api.SearchMembersAsync(qr.MemberCode)).Any(m => m.Id == qr.Id));
        Check((await api.SearchMembersAsync(input.Marker)).Any(m => m.Id == qr.Id));

        stage = "edit-qr";
        string editedQrName = input.Marker + " QR แก้ไขจาก POS";
        var editedQr = await api.UpdateMemberAsync(qr.Id, new CreateMemberRequest { Name = editedQrName, Phone = input.QrPhone, Sex = "female", Dob = "1990-01-01", Remark = input.Marker });
        Check(editedQr.Id == qr.Id && editedQr.MemberCode == qr.MemberCode && editedQr.DisplayName == editedQrName);
        Check((await api.GetMemberAsync(qr.Id)).DisplayName == editedQrName);

        stage = "create-pos";
        string name = input.Marker + " POS สมัครใหม่";
        var created = await api.CreateMemberAsync(new CreateMemberRequest { Name = name, Phone = input.PosPhone, Remark = input.Marker });
        Check(!string.IsNullOrEmpty(created.Id) && created.DisplayName == name && !created.PointsAvailable);
        Check((await api.GetMemberAsync(created.Id)).MemberCode == created.MemberCode);
        Check((await api.SearchMembersAsync(input.PosPhone)).Any(m => m.Id == created.Id));

        stage = "duplicate-create";
        await ExpectRejected(() => api.CreateMemberAsync(new CreateMemberRequest { Name = input.Marker + " must not replace", Phone = input.PosPhone }));
        Check((await api.GetMemberAsync(created.Id)).DisplayName == name);

        stage = "edit-pos-phone";
        string posEditedName = input.Marker + " POS แก้ไขแล้ว";
        var posEdited = await api.UpdateMemberAsync(created.Id, new CreateMemberRequest { Name = posEditedName, Phone = input.PosEditedPhone, Remark = input.Marker });
        Check(posEdited.Id == created.Id && posEdited.Phone == input.PosEditedPhone && posEdited.MemberCode == created.MemberCode);
        Check((await api.SearchMembersAsync(input.PosEditedPhone)).Any(m => m.Id == created.Id));
        Check(!(await api.SearchMembersAsync(input.PosPhone)).Any(m => m.Id == created.Id));

        stage = "duplicate-edit-rollback";
        await ExpectRejected(() => api.UpdateMemberAsync(created.Id, new CreateMemberRequest { Name = input.Marker + " must roll back", Phone = input.QrPhone }));
        var unchanged = await api.GetMemberAsync(created.Id);
        Check(unchanged.DisplayName == posEditedName && unchanged.Phone == input.PosEditedPhone);

        stage = "unsupported-medical-write";
        await ExpectRejected(() => api.UpdateMemberAsync(qr.Id, new CreateMemberRequest { Name = input.Marker + " must not save", Phone = input.QrPhone, PharmacyMedRecord = new SCCRMonPOS.Models.PharmacyMedRecord { WeightKg = "50" } }));
        Check((await api.GetMemberAsync(qr.Id)).DisplayName == editedQrName);
        Console.WriteLine("{\"ok\":true,\"mode\":\"live\",\"checks\":" + checks + ",\"posId\":\"" + created.Id + "\"}");
    }
}
