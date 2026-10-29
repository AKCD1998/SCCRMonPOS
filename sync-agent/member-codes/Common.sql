CREATE PROCEDURE dbo.SCCRM_AssertMemberCodeScope @Role varchar(12)
AS
BEGIN
 SET NOCOUNT ON;
 IF DB_NAME()<>'__DATABASE__' OR CONVERT(nvarchar(128),SERVERPROPERTY('MachineName'))<>N'__MACHINE__'
 OR IS_SRVROLEMEMBER('sysadmin')<>0
 BEGIN RAISERROR('MEMBER_CODES_TARGET_REFUSED',16,1);RETURN;END;
 __COPY_GUARD__
 IF NOT EXISTS(SELECT 1 FROM sys.extended_properties WHERE class=1
  AND major_id=OBJECT_ID('dbo.SCCRM_MemberCodeScope') AND name='SCCRM_MemberCodesMarker'
  AND CONVERT(nvarchar(36),value)='64fa3170-80ae-45ee-b9f3-7478b2a46e34')
 OR NOT EXISTS(SELECT 1 FROM dbo.SCCRM_MemberCodeScope WHERE singleton=1
  AND marker='64fa3170-80ae-45ee-b9f3-7478b2a46e34' AND scope='SCCRM-HQ-MEMBER-CODES-V1'
  AND role=@Role AND role='__ROLE__' AND database_name=N'__DATABASE__' AND machine_name=N'__MACHINE__'
  AND branch_code='__BRANCH__' AND native_format='AR000-######'
  AND CONVERT(varbinary(max),hq_identity)=CONVERT(varbinary(max),'__HQ_IDENTITY__')
  AND CONVERT(varbinary(max),target_identity)=CONVERT(varbinary(max),'__TARGET_IDENTITY__'))
 BEGIN RAISERROR('MEMBER_CODES_SCOPE_REFUSED',16,1);RETURN;END;
END;
GO
CREATE PROCEDURE dbo.SCCRM_AssertMemberCodeProfile
 @MemberId uniqueidentifier,@Name nvarchar(max),@Phone varchar(max),@Email nvarchar(max)
AS
BEGIN
 SET NOCOUNT ON;
 IF @MemberId IS NULL OR @Name IS NULL OR DATALENGTH(@Name)=0 OR DATALENGTH(@Name)>400
 OR CONVERT(varbinary(max),@Name)<>CONVERT(varbinary(max),LTRIM(RTRIM(@Name)))
 OR @Phone IS NULL OR DATALENGTH(@Phone)<>10 OR LEFT(@Phone,1)<>'0'
 OR @Phone COLLATE Latin1_General_BIN LIKE '%[^0-9]%'
 OR @Email IS NULL OR DATALENGTH(@Email)>200
 OR CONVERT(varbinary(max),CONVERT(nvarchar(max),CONVERT(varchar(200),@Name COLLATE Thai_CI_AS)))<>CONVERT(varbinary(max),@Name)
 OR CONVERT(varbinary(max),CONVERT(nvarchar(max),CONVERT(varchar(100),@Email COLLATE Thai_CI_AS)))<>CONVERT(varbinary(max),@Email)
 BEGIN RAISERROR('MEMBER_CODES_PROFILE_NOT_REPRESENTABLE',16,1);RETURN;END;
END;
GO
CREATE PROCEDURE dbo.SCCRM_AssertNoCustomerCodeReferences @Code varchar(20)
AS
BEGIN
 SET NOCOUNT ON;SET LOCK_TIMEOUT 1000;SET DEADLOCK_PRIORITY LOW;
 DECLARE @Found bit;
 -- Installer emits static, indexed predicates from the reviewed native schema.
 -- No dynamic SQL and no customer PIN column is ever projected.
 __REFERENCE_CHECKS__
END;
GO
CREATE PROCEDURE dbo.SCCRM_AllocateHqMemberCode @Code varchar(20) OUTPUT
AS
BEGIN
 SET NOCOUNT ON;
 IF @@TRANCOUNT=0 BEGIN RAISERROR('MEMBER_CODES_ALLOCATION_REQUIRES_TRANSACTION',16,1);RETURN;END;
 __NATIVE_FORMAT_GUARD__
 DECLARE @Sequence int,@Attempt int;
 -- PK range locks coordinate even with native clients which do not use our
 -- application lock. FTSatLastRun is a branch-format flag, never a counter.
 SELECT @Sequence=MAX(CASE WHEN DATALENGTH(FTCstCode)=12
  AND FTCstCode COLLATE Latin1_General_BIN LIKE 'AR000-[0-9][0-9][0-9][0-9][0-9][0-9]'
  THEN CONVERT(int,RIGHT(FTCstCode,6)) ELSE NULL END)
 FROM dbo.TCNMCst WITH(UPDLOCK,HOLDLOCK,INDEX(PK_TCNMCst))
 WHERE FTCstCode>='AR000-' AND FTCstCode<'AR001-' OPTION(MAXDOP 1);
 SET @Sequence=ISNULL(@Sequence,0)+1;SET @Attempt=0;
 WHILE @Attempt<8
 BEGIN
  IF @Sequence>999999 BEGIN RAISERROR('MEMBER_CODES_SEQUENCE_EXHAUSTED_REVIEW',16,1);RETURN;END;
  SET @Code='AR000-'+RIGHT('000000'+CONVERT(varchar(6),@Sequence),6);
  IF NOT EXISTS(SELECT 1 FROM dbo.TCNMCst WITH(UPDLOCK,HOLDLOCK,INDEX(PK_TCNMCst)) WHERE FTCstCode=@Code) RETURN;
  SET @Sequence=@Sequence+1;SET @Attempt=@Attempt+1;
 END;
 RAISERROR('MEMBER_CODES_ALLOCATION_COLLISION_REVIEW',16,1);
END;
