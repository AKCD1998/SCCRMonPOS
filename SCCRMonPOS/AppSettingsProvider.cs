using System;
using System.Collections.Generic;
using System.Configuration;
using System.Globalization;
using System.IO;
using System.Xml;

namespace SCCRMonPOS
{
    internal static class AppSettingsProvider
    {
        private const string SecretFileName = "SCCRMonPOS.secrets.config";
        private static readonly object SyncRoot = new object();
        private static Dictionary<string, string> _cachedSecrets;

        public static string Get(string key, string defaultValue = null)
        {
            string envValue = ReadEnvironmentValue(key);
            if (!string.IsNullOrWhiteSpace(envValue))
                return envValue;

            string secretValue = ReadSecretValue(key);
            if (!string.IsNullOrWhiteSpace(secretValue))
                return secretValue;

            string appConfigValue = ConfigurationManager.AppSettings[key];
            return string.IsNullOrWhiteSpace(appConfigValue) ? defaultValue : appConfigValue;
        }

        public static bool GetBool(string key, bool defaultValue)
        {
            string raw = Get(key, null);
            return bool.TryParse(raw, out bool value) ? value : defaultValue;
        }

        public static int GetInt(string key, int defaultValue)
        {
            string raw = Get(key, null);
            return int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value)
                ? value
                : defaultValue;
        }

        public static decimal GetDecimal(string key, decimal defaultValue)
        {
            string raw = Get(key, null);
            return decimal.TryParse(raw, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal value)
                ? value
                : defaultValue;
        }

        private static string ReadEnvironmentValue(string key)
        {
            return Environment.GetEnvironmentVariable("SCCRMONPOS__" + key);
        }

        private static string ReadSecretValue(string key)
        {
            return LoadSecretSettings().TryGetValue(key, out string value) ? value : null;
        }

        private static Dictionary<string, string> LoadSecretSettings()
        {
            if (_cachedSecrets != null)
                return _cachedSecrets;

            lock (SyncRoot)
            {
                if (_cachedSecrets != null)
                    return _cachedSecrets;

                var secrets = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

                foreach (string path in GetSecretFileCandidates())
                {
                    if (!File.Exists(path))
                        continue;

                    try
                    {
                        var doc = new XmlDocument();
                        doc.Load(path);
                        XmlNodeList nodes = doc.SelectNodes("/configuration/appSettings/add");
                        if (nodes == null)
                            continue;

                        foreach (XmlNode node in nodes)
                        {
                            string key = node.Attributes?["key"]?.Value;
                            if (string.IsNullOrWhiteSpace(key))
                                continue;

                            secrets[key] = node.Attributes?["value"]?.Value ?? "";
                        }

                        break;
                    }
                    catch
                    {
                        // Ignore malformed secret files and continue with tracked config.
                    }
                }

                _cachedSecrets = secrets;
                return _cachedSecrets;
            }
        }

        private static IEnumerable<string> GetSecretFileCandidates()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            yield return Path.Combine(baseDir, SecretFileName);

            string current = baseDir;
            for (int depth = 0; depth < 4 && !string.IsNullOrEmpty(current); depth += 1)
            {
                current = Path.GetDirectoryName(current);
                if (string.IsNullOrEmpty(current))
                    yield break;

                yield return Path.Combine(current, SecretFileName);
            }
        }
    }
}
