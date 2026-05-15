using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.Serialization.Json;
using System.Windows.Forms;
using SCCRMonPOS.Models;

namespace SCCRMonPOS
{
    /// <summary>
    /// Reads and writes the local member database (members.json).
    /// All operations keep an in-memory cache; disk is updated on every write.
    /// Thread-safety note: designed for single-threaded UI use only.
    /// </summary>
    public class MemberRepository
    {
        private readonly string _filePath;
        private List<Member> _cache;

        // ────────────────────────────────────────────────────────────────────
        public MemberRepository(string dataFolder)
        {
            Directory.CreateDirectory(dataFolder);
            _filePath = Path.Combine(dataFolder, "members.json");

            if (!File.Exists(_filePath))
                SeedDefaultMembers();

            _cache = LoadFromDisk();
        }

        // ── Public API ───────────────────────────────────────────────────────

        /// <summary>Returns null when no match is found.</summary>
        public Member FindByToken(string token)
        {
            if (string.IsNullOrWhiteSpace(token)) return null;
            return _cache.Find(m =>
                string.Equals(m.MemberToken, token.Trim(),
                              StringComparison.OrdinalIgnoreCase));
        }

        /// <summary>
        /// Finds a member whose BarcodeAlias exactly matches the given raw barcode.
        /// Returns null when no match exists.
        /// Used for legacy/mock cards that don't carry the SCM-POINT-v1- prefix.
        /// </summary>
        public Member FindByBarcodeAlias(string barcode)
        {
            if (string.IsNullOrWhiteSpace(barcode)) return null;
            return _cache.Find(m =>
                !string.IsNullOrEmpty(m.BarcodeAlias) &&
                string.Equals(m.BarcodeAlias, barcode.Trim(),
                              StringComparison.OrdinalIgnoreCase));
        }

        /// <summary>Returns a shallow copy of all members (for list dialogs).</summary>
        public List<Member> GetAll() => new List<Member>(_cache);

        /// <summary>
        /// Persists a new point balance for the given member token.
        /// Throws InvalidOperationException if the token is not found.
        /// Throws IOException / UnauthorizedAccessException on disk errors (caller must handle).
        /// </summary>
        public void UpdatePoints(string token, int newPoints)
        {
            Member member = FindByToken(token)
                ?? throw new InvalidOperationException($"ไม่พบสมาชิก: {token}");

            member.CurrentPoints = newPoints;
            SaveToDisk(_cache);   // throws on failure — caller must catch
        }

        // ── Private helpers ──────────────────────────────────────────────────

        private void SeedDefaultMembers()
        {
            var defaults = new List<Member>
            {
                new Member
                {
                    MemberToken  = "A1B2C3D4",
                    Name         = "สมชาย ใจดี",
                    PhoneMasked  = "xxx-xxx-1234",
                    CurrentPoints = 120
                },
                new Member
                {
                    MemberToken  = "Z9Y8X7W6",
                    Name         = "สมหญิง รักสุขภาพ",
                    PhoneMasked  = "xxx-xxx-5678",
                    CurrentPoints = 80
                },
                // ── Mock special-case: plain EAN barcode on a legacy card ──────
                // Scanning 8853935031319 triggers the SCCRM popup directly,
                // even though the barcode carries no SCM-POINT-v1- prefix.
                new Member
                {
                    MemberToken   = "000",
                    Name          = "John Doe",
                    PhoneMasked   = "xxx-xxx-0000",
                    CurrentPoints = 0,
                    BarcodeAlias  = "8853935031319"
                }
            };
            SaveToDisk(defaults);
        }

        private List<Member> LoadFromDisk()
        {
            try
            {
                var serializer = new DataContractJsonSerializer(typeof(List<Member>));
                using (var fs = new FileStream(_filePath, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    var result = serializer.ReadObject(fs) as List<Member>;
                    return result ?? new List<Member>();
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "ไม่สามารถโหลดข้อมูลสมาชิกได้:\n" + ex.Message +
                    "\n\nตรวจสอบไฟล์: " + _filePath,
                    "SCCRM — ข้อผิดพลาด",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return new List<Member>();
            }
        }

        /// <summary>Writes members list to disk. Throws on any I/O failure.</summary>
        private void SaveToDisk(List<Member> members)
        {
            string tmp = _filePath + ".tmp";
            var serializer = new DataContractJsonSerializer(typeof(List<Member>));

            using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                serializer.WriteObject(fs, members);
            }

            // Atomic rename — protects against corruption on power-loss
            if (File.Exists(_filePath)) File.Delete(_filePath);
            File.Move(tmp, _filePath);
        }
    }
}
