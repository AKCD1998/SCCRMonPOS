using System;
using System.Collections.Generic;
using System.Configuration;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace SCCRMonPOS
{
    /// <summary>
    /// Persists the staff device ID and token to data/staff-config.json.
    ///
    /// The staff token is encrypted with Windows DPAPI (ProtectedData,
    /// DataProtectionScope.CurrentUser) before being written to disk,
    /// so the raw token is never stored in plaintext.
    ///
    /// File format (new): { "deviceId": "...", "encryptedToken": "base64..." }
    /// File format (legacy): { "deviceId": "...", "staffToken": "..." }
    ///   → legacy files are migrated to the new format on the next SaveToken() call.
    /// </summary>
    public class StaffAuthManager
    {
        private readonly string _configFile;

        private string _deviceId;
        private string _staffToken;

        public string DeviceId   { get { return _deviceId; } }
        public string StaffToken { get { return _staffToken; } }
        public bool   HasToken   { get { return !string.IsNullOrEmpty(_staffToken); } }

        public string DeviceName
        {
            get
            {
                string name = AppSettingsProvider.Get("StaffDeviceName", null);
                return string.IsNullOrWhiteSpace(name) ? Environment.MachineName : name;
            }
        }

        public StaffAuthManager(string dataFolder)
        {
            _configFile = Path.Combine(dataFolder, "staff-config.json");
            Load();
        }

        // ── Load ─────────────────────────────────────────────────────────────

        private void Load()
        {
            if (!File.Exists(_configFile)) { _deviceId = NewDeviceId(); return; }
            try
            {
                string json = File.ReadAllText(_configFile, Encoding.UTF8);
                var dict = ParseSimpleJson(json);

                _deviceId = (dict.ContainsKey("deviceId") ? dict["deviceId"] : null)
                           ?? NewDeviceId();
                if (string.IsNullOrWhiteSpace(_deviceId))
                    _deviceId = NewDeviceId();

                // ── New format: DPAPI-encrypted token ──
                if (dict.ContainsKey("encryptedToken") &&
                    !string.IsNullOrEmpty(dict["encryptedToken"]))
                {
                    _staffToken = DecryptToken(dict["encryptedToken"]);
                    // DecryptToken returns null if decryption fails (wrong user / corrupted).
                }
                // ── Legacy format: plaintext token — migrate on next save ──
                else if (dict.ContainsKey("staffToken") &&
                         !string.IsNullOrEmpty(dict["staffToken"]))
                {
                    _staffToken = dict["staffToken"];
                    SaveToken(_staffToken);   // re-persist in encrypted format
                }
            }
            catch
            {
                _deviceId   = NewDeviceId();
                _staffToken = null;
            }
        }

        // ── Save / Clear ──────────────────────────────────────────────────────

        public void SaveToken(string staffToken)
        {
            _staffToken = staffToken;
            Directory.CreateDirectory(Path.GetDirectoryName(_configFile));

            string encryptedValue = string.IsNullOrEmpty(staffToken)
                ? null
                : EncryptToken(staffToken);

            string json =
                "{\"deviceId\":"        + JsonStr(_deviceId)      + "," +
                "\"encryptedToken\":"   + JsonStr(encryptedValue)  + "}";

            File.WriteAllText(_configFile, json, Encoding.UTF8);
        }

        public void ClearToken()
        {
            _staffToken = null;
            SaveToken(null);
        }

        // ── DPAPI helpers ─────────────────────────────────────────────────────

        private static string EncryptToken(string token)
        {
            try
            {
                byte[] data      = Encoding.UTF8.GetBytes(token);
                byte[] encrypted = ProtectedData.Protect(
                    data, null, DataProtectionScope.CurrentUser);
                return Convert.ToBase64String(encrypted);
            }
            catch
            {
                // DPAPI unavailable (e.g. service account without profile).
                // Fall back to base64 obfuscation — not secure but non-blocking.
                return "plain:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(token));
            }
        }

        private static string DecryptToken(string encrypted)
        {
            if (string.IsNullOrEmpty(encrypted)) return null;
            try
            {
                // Plain fallback written by EncryptToken when DPAPI unavailable
                if (encrypted.StartsWith("plain:"))
                    return Encoding.UTF8.GetString(
                        Convert.FromBase64String(encrypted.Substring(6)));

                byte[] cipherBytes = Convert.FromBase64String(encrypted);
                byte[] data        = ProtectedData.Unprotect(
                    cipherBytes, null, DataProtectionScope.CurrentUser);
                return Encoding.UTF8.GetString(data);
            }
            catch
            {
                // Different Windows user or corrupted blob → treat as invalid.
                return null;
            }
        }

        // ── Hand-rolled JSON helpers ──────────────────────────────────────────

        /// <summary>
        /// Minimal JSON object parser that handles only string and null values.
        /// Sufficient for the two-field staff-config.json.
        /// </summary>
        private static Dictionary<string, string> ParseSimpleJson(string json)
        {
            var dict = new Dictionary<string, string>(StringComparer.Ordinal);
            if (string.IsNullOrEmpty(json)) return dict;

            // Match "key": "value"  or  "key": null
            var matches = Regex.Matches(
                json,
                "\"([^\"\\\\]+)\"\\s*:\\s*(?:\"((?:[^\"\\\\]|\\\\.)*)\"|null)");

            foreach (Match m in matches)
            {
                string key = m.Groups[1].Value;
                string val = m.Groups[2].Success
                    ? m.Groups[2].Value
                        .Replace("\\\"", "\"")
                        .Replace("\\\\", "\\")
                    : null;
                dict[key] = val;
            }
            return dict;
        }

        /// <summary>Returns a JSON string literal (with quotes) or "null".</summary>
        private static string JsonStr(string value)
        {
            if (value == null) return "null";
            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

        private static string NewDeviceId()
        {
            return "pos-" +
                   Environment.MachineName.ToLower() + "-" +
                   Guid.NewGuid().ToString("N").Substring(0, 8);
        }
    }
}
