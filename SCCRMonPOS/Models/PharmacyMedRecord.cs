namespace SCCRMonPOS.Models
{
    public class PharmacyMedRecord
    {
        public string MemberId { get; set; }

        // 5 — ข้อมูลสุขภาพพื้นฐาน
        public string WeightKg     { get; set; }
        public string HeightCm     { get; set; }
        public string BpSystolic   { get; set; }
        public string BpDiastolic  { get; set; }
        public string BloodType    { get; set; }  // A / B / AB / O
        public string BloodRh      { get; set; }  // + / -

        // 7 — โรคประจำตัว
        public bool   HasDiabetes        { get; set; }
        public bool   HasHypertension    { get; set; }
        public bool   HasHyperlipidemia  { get; set; }
        public bool   HasHeartDisease    { get; set; }
        public bool   HasKidneyDisease   { get; set; }
        public bool   HasLiverDisease    { get; set; }
        public bool   HasThyroidDisease  { get; set; }
        public string OtherConditions    { get; set; }

        // 8 — ประวัติแพ้ยาและอาหาร
        public string DrugAllergies  { get; set; }
        public string FoodAllergies  { get; set; }

        // 9 — ประวัติการใช้ยาปัจจุบัน
        public string CurrentMedications { get; set; }

        // 10 — ประวัติการเจ็บป่วย
        public string MedicalHistory { get; set; }

        // 12 — ข้อมูลการคัดกรอง
        public bool IsSmoker        { get; set; }
        public bool DrinksAlcohol   { get; set; }
        public bool IsPregnant      { get; set; }
        public bool IsBreastfeeding { get; set; }
    }
}
