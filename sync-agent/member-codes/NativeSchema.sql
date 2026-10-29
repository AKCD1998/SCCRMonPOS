-- New owned objects only. The installer refuses partial/unowned collisions.
CREATE TABLE dbo.SCCRM_MemberCodeScope(
 singleton tinyint NOT NULL PRIMARY KEY CHECK(singleton=1),marker uniqueidentifier NOT NULL,
 scope varchar(80) NOT NULL,hq_identity varchar(160) NOT NULL,target_identity varchar(160) NOT NULL,
 database_name nvarchar(128) NOT NULL,machine_name nvarchar(128) NOT NULL,branch_code char(3) NOT NULL,
 role varchar(12) NOT NULL CHECK(role IN('hq','branch')),native_format varchar(50) NOT NULL,
 reference_count int NOT NULL,reference_schema_hash varchar(64) NOT NULL,created_at datetime NOT NULL,
 runtime_login sysname NULL,runtime_sid varbinary(85) NULL,authority_login sysname NULL,authority_sid varbinary(85) NULL,
 creator_login sysname NULL,creator_sid varbinary(85) NULL
);
CREATE TABLE dbo.SCCRM_MemberCodeAssignments(
 assignment_id uniqueidentifier NOT NULL PRIMARY KEY,member_id uniqueidentifier NOT NULL UNIQUE,
 ada_code varchar(20) NOT NULL UNIQUE,previous_code varchar(20) NULL,
 assignment_kind varchar(24) NOT NULL CHECK(assignment_kind IN('hq_create','approved_existing')),
 hq_identity varchar(160) NOT NULL,profile_name nvarchar(200) NOT NULL,
 profile_phone varchar(30) NOT NULL,profile_email nvarchar(100) NOT NULL,assigned_at datetime NOT NULL
);
CREATE INDEX IX_SCCRM_MemberCodeAssignments_Previous ON dbo.SCCRM_MemberCodeAssignments(previous_code);
CREATE TABLE dbo.SCCRM_MemberCodeMigrationCohort(
 member_id uniqueidentifier NOT NULL PRIMARY KEY,previous_code varchar(20) NOT NULL UNIQUE,
 profile_name nvarchar(200) NOT NULL,profile_phone varchar(30) NOT NULL,
 profile_email nvarchar(100) NOT NULL,approved_at datetime NOT NULL
);
CREATE TABLE dbo.SCCRM_MemberCodeApprovals(
 assignment_id uniqueidentifier NOT NULL PRIMARY KEY,member_id uniqueidentifier NOT NULL UNIQUE,
 ada_code varchar(20) NOT NULL UNIQUE,previous_code varchar(20) NULL,assignment_kind varchar(24) NOT NULL,
 hq_identity varchar(160) NOT NULL,target_identity varchar(160) NOT NULL,
 profile_name nvarchar(200) NOT NULL,profile_phone varchar(30) NOT NULL,profile_email nvarchar(100) NOT NULL,
 profile_hash varchar(64) NOT NULL,assignment_hash varchar(64) NOT NULL,
 assigned_at datetime NOT NULL,approved_at datetime NOT NULL
);
CREATE INDEX IX_SCCRM_MemberCodeApprovals_Previous ON dbo.SCCRM_MemberCodeApprovals(previous_code);
CREATE TABLE dbo.SCCRM_MemberCodeReceipts(
 assignment_id uniqueidentifier NOT NULL PRIMARY KEY,member_id uniqueidentifier NOT NULL UNIQUE,
 ada_code varchar(20) NOT NULL UNIQUE,target_identity varchar(160) NOT NULL,
 profile_hash varchar(64) NOT NULL,assignment_hash varchar(64) NOT NULL,received_at datetime NOT NULL
);
CREATE TABLE dbo.SCCRM_MemberCodeAliases(
 previous_code varchar(20) NOT NULL PRIMARY KEY,member_id uniqueidentifier NOT NULL UNIQUE,
 assignment_id uniqueidentifier NOT NULL UNIQUE,ada_code varchar(20) NOT NULL UNIQUE,
 hq_identity varchar(160) NOT NULL,target_identity varchar(160) NOT NULL,
 profile_name nvarchar(200) NOT NULL,profile_phone varchar(30) NOT NULL,profile_email nvarchar(100) NOT NULL,
 profile_hash varchar(64) NULL,assignment_hash varchar(64) NULL,created_at datetime NOT NULL
);
