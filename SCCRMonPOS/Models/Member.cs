using System.Runtime.Serialization;

namespace SCCRMonPOS.Models
{
    /// <summary>
    /// Represents a single loyalty-programme member stored in members.json.
    /// DataMember names are camelCase so the JSON file is human-readable.
    /// </summary>
    [DataContract]
    public class Member
    {
        [DataMember(Name = "memberToken")]
        public string MemberToken { get; set; }

        [DataMember(Name = "name")]
        public string Name { get; set; }

        /// <summary>Masked phone number, e.g. "xxx-xxx-1234".</summary>
        [DataMember(Name = "phoneMasked")]
        public string PhoneMasked { get; set; }

        [DataMember(Name = "currentPoints")]
        public int CurrentPoints { get; set; }

        /// <summary>
        /// Optional raw barcode/EAN that maps directly to this member.
        /// Used for mock/legacy cards that don't carry the SCM-POINT-v1- prefix.
        /// Leave null or omit in JSON for normal members.
        /// </summary>
        [DataMember(Name = "barcodeAlias", EmitDefaultValue = false)]
        public string BarcodeAlias { get; set; }
    }
}
