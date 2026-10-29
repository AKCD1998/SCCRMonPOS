CREATE PROCEDURE dbo.SCCRM_CreateMemberFromSccrmV2
 @MemberId uniqueidentifier,@Name nvarchar(200),@Phone varchar(30),@Email nvarchar(100)
AS
BEGIN
 SET NOCOUNT ON;SET XACT_ABORT ON;SET LOCK_TIMEOUT 1000;SET DEADLOCK_PRIORITY LOW;
 DECLARE @Code varchar(20),@AssignmentId uniqueidentifier,@Outcome varchar(24),@Lock int;
 DECLARE @Issue datetime,@Error nvarchar(4000),@Number int;
 SET @Email=ISNULL(@Email,N'');SET @Issue=DATEADD(day,DATEDIFF(day,0,GETDATE()),0);
 BEGIN TRY
  EXEC dbo.SCCRM_AssertMemberCodeScope 'hq';
  EXEC dbo.SCCRM_AssertMemberCodeProfile @MemberId,@Name,@Phone,@Email;
  BEGIN TRAN;
  EXEC @Lock=sys.sp_getapplock @Resource='SCCRM_LiveMemberCreate',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=1000;
  IF @Lock<0 RAISERROR('MEMBER_CODES_BUSY',16,1);
  SELECT @AssignmentId=assignment_id,@Code=ada_code FROM dbo.SCCRM_MemberCodeAssignments WITH(UPDLOCK,HOLDLOCK) WHERE member_id=@MemberId;
  IF @AssignmentId IS NOT NULL
  BEGIN
   IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_MemberCodeAssignments a JOIN dbo.TCNMCst c WITH(UPDLOCK,HOLDLOCK) ON c.FTCstCode=a.ada_code
    WHERE a.assignment_id=@AssignmentId AND a.hq_identity='__HQ_IDENTITY__'
    AND CONVERT(varbinary(max),a.profile_name)=CONVERT(varbinary(max),@Name)
    AND CONVERT(varbinary(max),a.profile_phone)=CONVERT(varbinary(max),@Phone)
    AND CONVERT(varbinary(max),a.profile_email)=CONVERT(varbinary(max),@Email)
    AND CONVERT(varbinary(max),CONVERT(nvarchar(200),c.FTCstName))=CONVERT(varbinary(max),a.profile_name)
    AND CONVERT(varbinary(max),ISNULL(c.FTCstTel,''))=CONVERT(varbinary(max),a.profile_phone)
    AND CONVERT(varbinary(max),CONVERT(nvarchar(100),ISNULL(c.FTCstEmail,'')))=CONVERT(varbinary(max),a.profile_email)
    AND c.FDCstCrdIssue IS NOT NULL AND c.FDCstCrdExpire>=@Issue AND ISNULL(c.FTCstStaActive,'')<>'2')
   RAISERROR('MEMBER_CODES_ASSIGNED_PROFILE_CHANGED_REVIEW',16,1);
   SET @Outcome='existing';
  END
  ELSE
  BEGIN
   IF EXISTS(SELECT 1 FROM dbo.SCCRM_LiveMemberLink WITH(UPDLOCK,HOLDLOCK) WHERE member_id=@MemberId)
    RAISERROR('MEMBER_CODES_EXPLICIT_MIGRATION_REQUIRED',16,1);
   IF EXISTS(SELECT 1 FROM dbo.TCNMCst WITH(UPDLOCK,HOLDLOCK) WHERE
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(FTCstTel,''),' ',''),'-',''),'(',''),')',''),'+',''),'.','') LIKE '%'+@Phone+'%'
    OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(FTCstTel,''),' ',''),'-',''),'(',''),')',''),'+',''),'.','') LIKE '%66'+SUBSTRING(@Phone,2,9)+'%')
    RAISERROR('MEMBER_CODES_EXISTING_CUSTOMER_REVIEW',16,1);
   EXEC dbo.SCCRM_AllocateHqMemberCode @Code OUTPUT;
   SET @AssignmentId=NEWID();
   INSERT dbo.TCNMCst(FTCstCode,FTCstName,FTCstTel,FTCstEmail,FTBchCode,FTCstStaActive,
    FDCstCrdIssue,FDCstCrdExpire,FCCstRetPoint,FCCstRetAmt,FCCstWhsPoint,FCCstDailyPoint,
    FDDateIns,FTTimeIns,FTWhoIns,FDDateUpd,FTTimeUpd,FTWhoUpd)
   VALUES(@Code,CONVERT(varchar(200),@Name COLLATE Thai_CI_AS),@Phone,CONVERT(varchar(100),@Email COLLATE Thai_CI_AS),'000','1',
    @Issue,DATEADD(year,100,@Issue),0,0,0,0,GETDATE(),CONVERT(varchar(8),GETDATE(),108),'SCCRM_SYNC_CREATE',GETDATE(),CONVERT(varchar(8),GETDATE(),108),'SCCRM_SYNC_CREATE');
   IF @@ROWCOUNT<>1 RAISERROR('MEMBER_CODES_INSERT_NOT_CONFIRMED',16,1);
   INSERT dbo.SCCRM_LiveMemberLink(member_id,ada_code,created_at,profile_name,profile_phone,profile_email)
    VALUES(@MemberId,@Code,GETDATE(),@Name,@Phone,@Email);
   INSERT dbo.SCCRM_MemberCodeAssignments(assignment_id,member_id,ada_code,previous_code,assignment_kind,hq_identity,profile_name,profile_phone,profile_email,assigned_at)
    VALUES(@AssignmentId,@MemberId,@Code,NULL,'hq_create','__HQ_IDENTITY__',@Name,@Phone,@Email,GETUTCDATE());
   SET @Outcome='created';
  END;
  COMMIT;
 END TRY
 BEGIN CATCH
  SET @Error=ERROR_MESSAGE();SET @Number=ERROR_NUMBER();IF XACT_STATE()<>0 ROLLBACK;
  IF @Error LIKE 'MEMBER[_]CODES[_]%' AND @Error NOT LIKE '%[^A-Z_]%' RAISERROR(@Error,16,1);
  ELSE IF @Number IN(1205,1222) RAISERROR('MEMBER_CODES_BUSY',16,1);
  ELSE IF @Number IN(2601,2627) RAISERROR('MEMBER_CODES_ALLOCATION_COLLISION_REVIEW',16,1);
  ELSE RAISERROR('MEMBER_CODES_CREATE_FAILED',16,1);
  RETURN;
 END CATCH;
 SELECT LOWER(CONVERT(varchar(36),a.member_id)) member_id,a.ada_code,@Outcome outcome,
  LOWER(CONVERT(varchar(36),a.assignment_id)) assignment_id,a.assignment_kind,a.previous_code,a.hq_identity,
  a.profile_name,a.profile_phone,a.profile_email,CONVERT(varchar(23),a.assigned_at,126)+'Z' assigned_at
 FROM dbo.SCCRM_MemberCodeAssignments a WHERE a.assignment_id=@AssignmentId;
END;
GO
CREATE PROCEDURE dbo.SCCRM_MigrateOwnedMemberCode
 @MemberId uniqueidentifier,@PreviousCode varchar(20),@ExpectedName nvarchar(200),@ExpectedPhone varchar(30),@ExpectedEmail nvarchar(100)
AS
BEGIN
 SET NOCOUNT ON;SET XACT_ABORT ON;SET LOCK_TIMEOUT 1000;SET DEADLOCK_PRIORITY LOW;
 DECLARE @Code varchar(20),@ExpectedPrevious varchar(20),@AssignmentId uniqueidentifier,@Lock int,@Outcome varchar(24);
 DECLARE @Issue datetime,@ExistingIssue datetime,@ExistingExpiry datetime,@Error nvarchar(4000),@Number int;
 SET @ExpectedEmail=ISNULL(@ExpectedEmail,N'');
 SET @ExpectedPrevious='SC-'+UPPER(LEFT(REPLACE(CONVERT(varchar(36),@MemberId),'-',''),16));
 BEGIN TRY
  EXEC dbo.SCCRM_AssertMemberCodeScope 'hq';
  EXEC dbo.SCCRM_AssertMemberCodeProfile @MemberId,@ExpectedName,@ExpectedPhone,@ExpectedEmail;
  IF CONVERT(varbinary(max),@PreviousCode)<>CONVERT(varbinary(max),@ExpectedPrevious)
   RAISERROR('MEMBER_CODES_MIGRATION_IDENTITY_REFUSED',16,1);
  BEGIN TRAN;
  EXEC @Lock=sys.sp_getapplock @Resource='SCCRM_LiveMemberCreate',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=1000;
  IF @Lock<0 RAISERROR('MEMBER_CODES_BUSY',16,1);
  IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_MemberCodeMigrationCohort WITH(UPDLOCK,HOLDLOCK) WHERE member_id=@MemberId AND previous_code=@PreviousCode
   AND CONVERT(varbinary(max),profile_name)=CONVERT(varbinary(max),@ExpectedName)
   AND CONVERT(varbinary(max),profile_phone)=CONVERT(varbinary(max),@ExpectedPhone)
   AND CONVERT(varbinary(max),profile_email)=CONVERT(varbinary(max),@ExpectedEmail))
   RAISERROR('MEMBER_CODES_COHORT_APPROVAL_REQUIRED',16,1);
  SELECT @AssignmentId=assignment_id,@Code=ada_code FROM dbo.SCCRM_MemberCodeAssignments WITH(UPDLOCK,HOLDLOCK) WHERE member_id=@MemberId;
  IF @AssignmentId IS NOT NULL
  BEGIN
   IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_MemberCodeAssignments a JOIN dbo.SCCRM_MemberCodeAliases x ON x.assignment_id=a.assignment_id
    JOIN dbo.TCNMCst c WITH(UPDLOCK,HOLDLOCK) ON c.FTCstCode=a.ada_code
    WHERE a.assignment_id=@AssignmentId AND a.assignment_kind='approved_existing' AND a.previous_code=@PreviousCode
    AND x.previous_code=@PreviousCode AND x.member_id=@MemberId AND x.ada_code=a.ada_code
    AND CONVERT(varbinary(max),a.profile_name)=CONVERT(varbinary(max),@ExpectedName)
    AND CONVERT(varbinary(max),a.profile_phone)=CONVERT(varbinary(max),@ExpectedPhone)
    AND CONVERT(varbinary(max),a.profile_email)=CONVERT(varbinary(max),@ExpectedEmail)
    AND CONVERT(varbinary(max),CONVERT(nvarchar(200),c.FTCstName))=CONVERT(varbinary(max),a.profile_name)
    AND CONVERT(varbinary(max),ISNULL(c.FTCstTel,''))=CONVERT(varbinary(max),a.profile_phone)
    AND CONVERT(varbinary(max),CONVERT(nvarchar(100),ISNULL(c.FTCstEmail,'')))=CONVERT(varbinary(max),a.profile_email))
    RAISERROR('MEMBER_CODES_MIGRATION_REPLAY_CHANGED_REVIEW',16,1);
   SET @Outcome='existing';
  END
  ELSE
  BEGIN
   IF NOT EXISTS(SELECT 1 FROM sys.extended_properties WHERE class=1 AND major_id=OBJECT_ID('dbo.SCCRM_LiveMemberLink')
    AND name='SCCRM_LiveSyncMarker' AND CONVERT(nvarchar(36),value)='ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b')
    RAISERROR('MEMBER_CODES_LEGACY_OWNERSHIP_REFUSED',16,1);
   SELECT @Issue=DATEADD(day,DATEDIFF(day,0,c.FDDateIns),0),@ExistingIssue=c.FDCstCrdIssue,@ExistingExpiry=c.FDCstCrdExpire
   FROM dbo.SCCRM_LiveMemberLink l WITH(UPDLOCK,HOLDLOCK) JOIN dbo.TCNMCst c WITH(UPDLOCK,HOLDLOCK) ON c.FTCstCode=l.ada_code
   WHERE l.member_id=@MemberId AND l.ada_code=@PreviousCode AND c.FTBchCode='000' AND c.FTWhoIns='SCCRM_SYNC_CREATE'
    AND c.FDDateIns IS NOT NULL AND c.FDDateIns<=GETDATE() AND c.FTCstStaActive='1'
    AND CONVERT(varbinary(max),l.profile_name)=CONVERT(varbinary(max),@ExpectedName)
    AND CONVERT(varbinary(max),l.profile_phone)=CONVERT(varbinary(max),@ExpectedPhone)
    AND CONVERT(varbinary(max),ISNULL(l.profile_email,N''))=CONVERT(varbinary(max),@ExpectedEmail)
    AND CONVERT(varbinary(max),CONVERT(nvarchar(200),c.FTCstName))=CONVERT(varbinary(max),@ExpectedName)
    AND CONVERT(varbinary(max),ISNULL(c.FTCstTel,''))=CONVERT(varbinary(max),@ExpectedPhone)
    AND CONVERT(varbinary(max),CONVERT(nvarchar(100),ISNULL(c.FTCstEmail,'')))=CONVERT(varbinary(max),@ExpectedEmail)
    AND ISNULL(c.FCCstRetPoint,0)=0 AND ISNULL(c.FCCstWhsPoint,0)=0 AND ISNULL(c.FCCstDailyPoint,0)=0;
   IF @Issue IS NULL RAISERROR('MEMBER_CODES_LEGACY_PROFILE_OR_POINTS_REVIEW',16,1);
   IF NOT(@ExistingIssue IS NULL AND @ExistingExpiry IS NULL)
    AND (@ExistingIssue IS NULL OR @ExistingExpiry IS NULL OR @ExistingIssue<>@Issue OR @ExistingExpiry<>DATEADD(year,100,@Issue))
    RAISERROR('MEMBER_CODES_EXISTING_CARD_DATES_REVIEW',16,1);
   EXEC dbo.SCCRM_AssertNoCustomerCodeReferences @PreviousCode;
   EXEC dbo.SCCRM_AllocateHqMemberCode @Code OUTPUT;
   SET @AssignmentId=NEWID();
   -- Preserve every native field except the approved primary code and, only
   -- for these newly-owned HQ rows, their previously absent card dates.
   UPDATE dbo.TCNMCst SET FTCstCode=@Code,
    FDCstCrdIssue=CASE WHEN FDCstCrdIssue IS NULL AND FDCstCrdExpire IS NULL THEN @Issue ELSE FDCstCrdIssue END,
    FDCstCrdExpire=CASE WHEN FDCstCrdIssue IS NULL AND FDCstCrdExpire IS NULL THEN DATEADD(year,100,@Issue) ELSE FDCstCrdExpire END
   WHERE FTCstCode=@PreviousCode;
   IF @@ROWCOUNT<>1 RAISERROR('MEMBER_CODES_MIGRATION_WRITE_REFUSED',16,1);
   INSERT dbo.SCCRM_MemberCodeAssignments(assignment_id,member_id,ada_code,previous_code,assignment_kind,hq_identity,profile_name,profile_phone,profile_email,assigned_at)
    VALUES(@AssignmentId,@MemberId,@Code,@PreviousCode,'approved_existing','__HQ_IDENTITY__',@ExpectedName,@ExpectedPhone,@ExpectedEmail,GETUTCDATE());
   INSERT dbo.SCCRM_MemberCodeAliases(previous_code,member_id,assignment_id,ada_code,hq_identity,target_identity,profile_name,profile_phone,profile_email,profile_hash,assignment_hash,created_at)
    VALUES(@PreviousCode,@MemberId,@AssignmentId,@Code,'__HQ_IDENTITY__','__TARGET_IDENTITY__',@ExpectedName,@ExpectedPhone,@ExpectedEmail,NULL,NULL,GETUTCDATE());
   -- The original SCCRM_LiveMemberLink is immutable audit; do not update it.
   SET @Outcome='migrated';
  END;
  COMMIT;
 END TRY
 BEGIN CATCH
  SET @Error=ERROR_MESSAGE();SET @Number=ERROR_NUMBER();IF XACT_STATE()<>0 ROLLBACK;
  IF @Error LIKE 'MEMBER[_]CODES[_]%' AND @Error NOT LIKE '%[^A-Z_]%' RAISERROR(@Error,16,1);
  ELSE IF @Number IN(1205,1222) RAISERROR('MEMBER_CODES_BUSY',16,1);
  ELSE IF @Number IN(2601,2627) RAISERROR('MEMBER_CODES_ALLOCATION_COLLISION_REVIEW',16,1);
  ELSE RAISERROR('MEMBER_CODES_MIGRATION_FAILED',16,1);
  RETURN;
 END CATCH;
 SELECT LOWER(CONVERT(varchar(36),a.member_id)) member_id,a.ada_code,@Outcome outcome,
  LOWER(CONVERT(varchar(36),a.assignment_id)) assignment_id,a.assignment_kind,a.previous_code,a.hq_identity,
  a.profile_name,a.profile_phone,a.profile_email,CONVERT(varchar(23),a.assigned_at,126)+'Z' assigned_at
 FROM dbo.SCCRM_MemberCodeAssignments a WHERE a.assignment_id=@AssignmentId;
END;
GO
CREATE PROCEDURE dbo.SCCRM_GetAssignedCustomerSnapshot @AssignmentId uniqueidentifier
AS
BEGIN
 SET NOCOUNT ON;SET LOCK_TIMEOUT 1000;SET DEADLOCK_PRIORITY LOW;
 BEGIN TRY
  EXEC dbo.SCCRM_AssertMemberCodeScope 'hq';
  SELECT __SNAPSHOT_COLUMNS__
  FROM dbo.SCCRM_MemberCodeAssignments a JOIN dbo.TCNMCst c ON c.FTCstCode=a.ada_code
  WHERE a.assignment_id=@AssignmentId AND a.hq_identity='__HQ_IDENTITY__'
   AND CONVERT(varbinary(max),CONVERT(nvarchar(200),c.FTCstName))=CONVERT(varbinary(max),a.profile_name)
   AND CONVERT(varbinary(max),ISNULL(c.FTCstTel,''))=CONVERT(varbinary(max),a.profile_phone)
   AND CONVERT(varbinary(max),CONVERT(nvarchar(100),ISNULL(c.FTCstEmail,'')))=CONVERT(varbinary(max),a.profile_email)
  OPTION(MAXDOP 1);
 END TRY
 BEGIN CATCH
  DECLARE @Error nvarchar(4000);SET @Error=ERROR_MESSAGE();
  IF @Error LIKE 'MEMBER[_]CODES[_]%' AND @Error NOT LIKE '%[^A-Z_]%' RAISERROR(@Error,16,1);
  ELSE RAISERROR('MEMBER_CODES_SNAPSHOT_FAILED',16,1);
 END CATCH;
END;
