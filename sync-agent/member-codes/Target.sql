CREATE PROCEDURE dbo.SCCRM_ApproveMemberCodeAssignment
 @AssignmentId uniqueidentifier,@MemberId uniqueidentifier,@HqCode varchar(max),@PreviousCode varchar(max),@Kind varchar(24),
 @Name nvarchar(max),@Phone varchar(max),@Email nvarchar(max),@ProfileHash varchar(max),@AssignmentHash varchar(max),
 @HqIdentity varchar(max),@TargetIdentity varchar(max),@AssignedAt datetime
AS
BEGIN
 SET NOCOUNT ON;SET XACT_ABORT ON;SET LOCK_TIMEOUT 1000;SET DEADLOCK_PRIORITY LOW;
 DECLARE @Lock int,@ExpectedPrevious varchar(20),@Error nvarchar(4000),@Number int;
 SET @Email=ISNULL(@Email,N'');SET @ExpectedPrevious='SC-'+UPPER(LEFT(REPLACE(CONVERT(varchar(36),@MemberId),'-',''),16));
 BEGIN TRY
  EXEC dbo.SCCRM_AssertMemberCodeScope 'branch';
  EXEC dbo.SCCRM_AssertMemberCodeProfile @MemberId,@Name,@Phone,@Email;
  IF @AssignmentId IS NULL OR @HqCode IS NULL OR DATALENGTH(@HqCode)<>12
   OR @HqCode COLLATE Latin1_General_BIN NOT LIKE 'AR000-[0-9][0-9][0-9][0-9][0-9][0-9]'
   OR @Kind COLLATE Latin1_General_BIN NOT IN('hq_create','approved_existing') OR @Kind IS NULL
   OR (@Kind='hq_create' AND @PreviousCode IS NOT NULL)
   OR (@Kind='approved_existing' AND (@PreviousCode IS NULL OR CONVERT(varbinary(max),@PreviousCode)<>CONVERT(varbinary(max),@ExpectedPrevious)))
   OR @ProfileHash IS NULL OR DATALENGTH(@ProfileHash)<>64 OR @ProfileHash COLLATE Latin1_General_BIN LIKE '%[^0-9a-f]%'
   OR @AssignmentHash IS NULL OR DATALENGTH(@AssignmentHash)<>64 OR @AssignmentHash COLLATE Latin1_General_BIN LIKE '%[^0-9a-f]%'
   OR @HqIdentity IS NULL OR CONVERT(varbinary(max),@HqIdentity)<>CONVERT(varbinary(max),'__HQ_IDENTITY__')
   OR @TargetIdentity IS NULL OR CONVERT(varbinary(max),@TargetIdentity)<>CONVERT(varbinary(max),'__TARGET_IDENTITY__')
   OR @AssignedAt IS NULL OR @AssignedAt>DATEADD(minute,5,GETUTCDATE())
   RAISERROR('MEMBER_CODES_ASSIGNMENT_NOT_REPRESENTABLE',16,1);
  BEGIN TRAN;
  EXEC @Lock=sys.sp_getapplock @Resource='SCCRM_FanoutMemberCreate',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=1000;
  IF @Lock<0 RAISERROR('MEMBER_CODES_BUSY',16,1);
  IF EXISTS(SELECT 1 FROM dbo.SCCRM_MemberCodeApprovals WITH(UPDLOCK,HOLDLOCK) WHERE assignment_id=@AssignmentId)
  BEGIN
   IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_MemberCodeApprovals WHERE assignment_id=@AssignmentId AND member_id=@MemberId
    AND CONVERT(varbinary(max),ada_code)=CONVERT(varbinary(max),@HqCode)
    AND ((previous_code IS NULL AND @PreviousCode IS NULL) OR CONVERT(varbinary(max),previous_code)=CONVERT(varbinary(max),@PreviousCode))
    AND assignment_kind=@Kind AND assigned_at=@AssignedAt
    AND CONVERT(varbinary(max),hq_identity)=CONVERT(varbinary(max),@HqIdentity)
    AND CONVERT(varbinary(max),target_identity)=CONVERT(varbinary(max),@TargetIdentity)
    AND CONVERT(varbinary(max),profile_name)=CONVERT(varbinary(max),@Name)
    AND CONVERT(varbinary(max),profile_phone)=CONVERT(varbinary(max),@Phone)
    AND CONVERT(varbinary(max),profile_email)=CONVERT(varbinary(max),@Email)
    AND CONVERT(varbinary(max),profile_hash)=CONVERT(varbinary(max),@ProfileHash)
    AND CONVERT(varbinary(max),assignment_hash)=CONVERT(varbinary(max),@AssignmentHash))
    RAISERROR('MEMBER_CODES_APPROVAL_IMMUTABLE_REVIEW',16,1);
  END
  ELSE
  BEGIN
   IF EXISTS(SELECT 1 FROM dbo.SCCRM_MemberCodeApprovals WITH(UPDLOCK,HOLDLOCK)
    WHERE member_id=@MemberId OR ada_code=@HqCode OR (previous_code=@PreviousCode AND @PreviousCode IS NOT NULL))
    RAISERROR('MEMBER_CODES_APPROVAL_COLLISION_REVIEW',16,1);
   IF @Kind='approved_existing'
   BEGIN
    IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_MemberCodeMigrationCohort WHERE member_id=@MemberId AND previous_code=@PreviousCode
     AND CONVERT(varbinary(max),profile_name)=CONVERT(varbinary(max),@Name)
     AND CONVERT(varbinary(max),profile_phone)=CONVERT(varbinary(max),@Phone)
     AND CONVERT(varbinary(max),profile_email)=CONVERT(varbinary(max),@Email))
     RAISERROR('MEMBER_CODES_COHORT_APPROVAL_REQUIRED',16,1);
    IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_FanoutMemberLink WITH(UPDLOCK,HOLDLOCK)
     WHERE member_id=@MemberId AND hq_code=@PreviousCode AND ada_code=@PreviousCode
     AND CONVERT(varbinary(max),target_identity)=CONVERT(varbinary(max),@TargetIdentity)
     AND CONVERT(varbinary(max),profile_name)=CONVERT(varbinary(max),@Name)
     AND CONVERT(varbinary(max),profile_phone)=CONVERT(varbinary(max),@Phone)
     AND CONVERT(varbinary(max),profile_email)=CONVERT(varbinary(max),@Email)
     AND CONVERT(varbinary(max),profile_hash)=CONVERT(varbinary(max),@ProfileHash))
     RAISERROR('MEMBER_CODES_LEGACY_OWNERSHIP_REFUSED',16,1);
   END;
   INSERT dbo.SCCRM_MemberCodeApprovals(assignment_id,member_id,ada_code,previous_code,assignment_kind,hq_identity,target_identity,
    profile_name,profile_phone,profile_email,profile_hash,assignment_hash,assigned_at,approved_at)
   VALUES(@AssignmentId,@MemberId,@HqCode,@PreviousCode,@Kind,@HqIdentity,@TargetIdentity,@Name,@Phone,@Email,@ProfileHash,@AssignmentHash,@AssignedAt,GETUTCDATE());
  END;
  COMMIT;
 END TRY
 BEGIN CATCH
  SET @Error=ERROR_MESSAGE();SET @Number=ERROR_NUMBER();IF XACT_STATE()<>0 ROLLBACK;
  IF @Error LIKE 'MEMBER[_]CODES[_]%' AND @Error NOT LIKE '%[^A-Z_]%' RAISERROR(@Error,16,1);
  ELSE IF @Number IN(1205,1222) RAISERROR('MEMBER_CODES_BUSY',16,1);
  ELSE IF @Number IN(2601,2627) RAISERROR('MEMBER_CODES_APPROVAL_COLLISION_REVIEW',16,1);
  ELSE RAISERROR('MEMBER_CODES_APPROVAL_FAILED',16,1);
  RETURN;
 END CATCH;
 SELECT LOWER(CONVERT(varchar(36),assignment_id)) assignment_id,assignment_hash,ada_code,
  CONVERT(varchar(23),approved_at,126)+'Z' approved_at FROM dbo.SCCRM_MemberCodeApprovals WHERE assignment_id=@AssignmentId;
END;
GO
CREATE PROCEDURE dbo.SCCRM_ReceiveAssignedMember
 @AssignmentId uniqueidentifier,@MemberId uniqueidentifier,@HqCode varchar(max),
 @Name nvarchar(max),@Phone varchar(max),@Email nvarchar(max),@ProfileHash varchar(max),@TargetIdentity varchar(max)
AS
BEGIN
 SET NOCOUNT ON;SET XACT_ABORT ON;SET LOCK_TIMEOUT 1000;SET DEADLOCK_PRIORITY LOW;
 DECLARE @Previous varchar(20),@Kind varchar(24),@AssignmentHash varchar(64),@Lock int,@Outcome varchar(24),@Issue datetime;
 DECLARE @Error nvarchar(4000),@Number int;
 SET @Email=ISNULL(@Email,N'');SET @Issue=DATEADD(day,DATEDIFF(day,0,GETDATE()),0);
 BEGIN TRY
  EXEC dbo.SCCRM_AssertMemberCodeScope 'branch';
  EXEC dbo.SCCRM_AssertMemberCodeProfile @MemberId,@Name,@Phone,@Email;
  IF @AssignmentId IS NULL OR @HqCode IS NULL OR DATALENGTH(@HqCode)<>12
   OR @HqCode COLLATE Latin1_General_BIN NOT LIKE 'AR000-[0-9][0-9][0-9][0-9][0-9][0-9]'
   OR @ProfileHash IS NULL OR DATALENGTH(@ProfileHash)<>64 OR @ProfileHash COLLATE Latin1_General_BIN LIKE '%[^0-9a-f]%'
   OR @TargetIdentity IS NULL OR CONVERT(varbinary(max),@TargetIdentity)<>CONVERT(varbinary(max),'__TARGET_IDENTITY__')
   RAISERROR('MEMBER_CODES_DELIVERY_NOT_REPRESENTABLE',16,1);
  BEGIN TRAN;
  EXEC @Lock=sys.sp_getapplock @Resource='SCCRM_FanoutMemberCreate',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=1000;
  IF @Lock<0 RAISERROR('MEMBER_CODES_BUSY',16,1);
  SELECT @Previous=previous_code,@Kind=assignment_kind,@AssignmentHash=assignment_hash
   FROM dbo.SCCRM_MemberCodeApprovals WITH(UPDLOCK,HOLDLOCK)
   WHERE assignment_id=@AssignmentId AND member_id=@MemberId
    AND CONVERT(varbinary(max),ada_code)=CONVERT(varbinary(max),@HqCode)
    AND CONVERT(varbinary(max),target_identity)=CONVERT(varbinary(max),@TargetIdentity)
    AND CONVERT(varbinary(max),hq_identity)=CONVERT(varbinary(max),'__HQ_IDENTITY__')
    AND CONVERT(varbinary(max),profile_name)=CONVERT(varbinary(max),@Name)
    AND CONVERT(varbinary(max),profile_phone)=CONVERT(varbinary(max),@Phone)
    AND CONVERT(varbinary(max),profile_email)=CONVERT(varbinary(max),@Email)
    AND CONVERT(varbinary(max),profile_hash)=CONVERT(varbinary(max),@ProfileHash);
  IF @Kind IS NULL RAISERROR('MEMBER_CODES_SEPARATE_APPROVAL_REQUIRED',16,1);
  IF EXISTS(SELECT 1 FROM dbo.SCCRM_MemberCodeReceipts WITH(UPDLOCK,HOLDLOCK) WHERE assignment_id=@AssignmentId)
  BEGIN
   IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_MemberCodeReceipts r JOIN dbo.TCNMCst c WITH(UPDLOCK,HOLDLOCK) ON c.FTCstCode=r.ada_code
    WHERE r.assignment_id=@AssignmentId AND r.member_id=@MemberId AND r.ada_code=@HqCode
     AND CONVERT(varbinary(max),r.target_identity)=CONVERT(varbinary(max),@TargetIdentity)
     AND CONVERT(varbinary(max),r.profile_hash)=CONVERT(varbinary(max),@ProfileHash)
     AND CONVERT(varbinary(max),r.assignment_hash)=CONVERT(varbinary(max),@AssignmentHash)
     AND CONVERT(varbinary(max),CONVERT(nvarchar(200),c.FTCstName))=CONVERT(varbinary(max),@Name)
     AND CONVERT(varbinary(max),ISNULL(c.FTCstTel,''))=CONVERT(varbinary(max),@Phone)
     AND CONVERT(varbinary(max),CONVERT(nvarchar(100),ISNULL(c.FTCstEmail,'')))=CONVERT(varbinary(max),@Email)
     AND c.FDCstCrdIssue IS NOT NULL AND c.FDCstCrdExpire>=@Issue AND ISNULL(c.FTCstStaActive,'')<>'2')
    RAISERROR('MEMBER_CODES_NATIVE_ACK_CHANGED_REVIEW',16,1);
   SET @Outcome='existing';
  END
  ELSE
  BEGIN
   IF EXISTS(SELECT 1 FROM dbo.SCCRM_MemberCodeReceipts WITH(UPDLOCK,HOLDLOCK) WHERE member_id=@MemberId OR ada_code=@HqCode)
    OR EXISTS(SELECT 1 FROM dbo.TCNMCst WITH(UPDLOCK,HOLDLOCK,INDEX(PK_TCNMCst)) WHERE FTCstCode=@HqCode)
    RAISERROR('MEMBER_CODES_UNOWNED_CODE_COLLISION_REVIEW',16,1);
   IF EXISTS(SELECT 1 FROM dbo.TCNMCst WITH(UPDLOCK,HOLDLOCK) WHERE (@Previous IS NULL OR FTCstCode<>@Previous) AND (
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(FTCstTel,''),' ',''),'-',''),'(',''),')',''),'+',''),'.','') LIKE '%'+@Phone+'%'
    OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(FTCstTel,''),' ',''),'-',''),'(',''),')',''),'+',''),'.','') LIKE '%66'+SUBSTRING(@Phone,2,9)+'%'))
    RAISERROR('MEMBER_CODES_EXISTING_CUSTOMER_REVIEW',16,1);
   IF @Kind='hq_create'
   BEGIN
    IF @Previous IS NOT NULL OR EXISTS(SELECT 1 FROM dbo.SCCRM_FanoutMemberLink WITH(UPDLOCK,HOLDLOCK) WHERE member_id=@MemberId)
     RAISERROR('MEMBER_CODES_LEGACY_MIGRATION_REQUIRED',16,1);
    INSERT dbo.TCNMCst(FTCstCode,FTCstName,FTCstTel,FTCstEmail,FTBchCode,FTCstStaActive,
     FDCstCrdIssue,FDCstCrdExpire,FCCstRetPoint,FCCstRetAmt,FCCstWhsPoint,FCCstDailyPoint,
     FDDateIns,FTTimeIns,FTWhoIns,FDDateUpd,FTTimeUpd,FTWhoUpd)
    VALUES(@HqCode,CONVERT(varchar(200),@Name COLLATE Thai_CI_AS),@Phone,CONVERT(varchar(100),@Email COLLATE Thai_CI_AS),'000','1',
     @Issue,DATEADD(year,100,@Issue),0,0,0,0,GETDATE(),CONVERT(varchar(8),GETDATE(),108),'SCCRM_FANOUT_CREATE',GETDATE(),CONVERT(varchar(8),GETDATE(),108),'SCCRM_FANOUT_CREATE');
    IF @@ROWCOUNT<>1 RAISERROR('MEMBER_CODES_INSERT_NOT_CONFIRMED',16,1);
    SET @Outcome='created';
   END
   ELSE IF @Kind='approved_existing'
   BEGIN
    IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_MemberCodeMigrationCohort WHERE member_id=@MemberId AND previous_code=@Previous
     AND CONVERT(varbinary(max),profile_name)=CONVERT(varbinary(max),@Name)
     AND CONVERT(varbinary(max),profile_phone)=CONVERT(varbinary(max),@Phone)
     AND CONVERT(varbinary(max),profile_email)=CONVERT(varbinary(max),@Email))
     RAISERROR('MEMBER_CODES_COHORT_APPROVAL_REQUIRED',16,1);
    IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_FanoutMemberLink l WITH(UPDLOCK,HOLDLOCK)
     JOIN dbo.TCNMCst c WITH(UPDLOCK,HOLDLOCK) ON c.FTCstCode=l.ada_code
     WHERE l.member_id=@MemberId AND l.hq_code=@Previous AND l.ada_code=@Previous
      AND CONVERT(varbinary(max),l.target_identity)=CONVERT(varbinary(max),@TargetIdentity)
      AND CONVERT(varbinary(max),l.profile_hash)=CONVERT(varbinary(max),@ProfileHash)
      AND CONVERT(varbinary(max),l.profile_name)=CONVERT(varbinary(max),@Name)
      AND CONVERT(varbinary(max),l.profile_phone)=CONVERT(varbinary(max),@Phone)
      AND CONVERT(varbinary(max),l.profile_email)=CONVERT(varbinary(max),@Email)
      AND CONVERT(varbinary(max),CONVERT(nvarchar(200),c.FTCstName))=CONVERT(varbinary(max),@Name)
      AND CONVERT(varbinary(max),ISNULL(c.FTCstTel,''))=CONVERT(varbinary(max),@Phone)
      AND CONVERT(varbinary(max),CONVERT(nvarchar(100),ISNULL(c.FTCstEmail,'')))=CONVERT(varbinary(max),@Email)
      AND c.FTBchCode='000' AND c.FTWhoIns='SCCRM_FANOUT_CREATE' AND c.FTCstStaActive='1'
      AND c.FDCstCrdIssue IS NOT NULL AND c.FDCstCrdIssue<=@Issue
      AND c.FDCstCrdExpire=DATEADD(year,100,CASE WHEN c.FDCstCrdIssue<=@Issue THEN c.FDCstCrdIssue ELSE @Issue END)
      AND c.FDCstCrdExpire>=@Issue
      AND ISNULL(c.FCCstRetPoint,0)=0 AND ISNULL(c.FCCstWhsPoint,0)=0 AND ISNULL(c.FCCstDailyPoint,0)=0)
     RAISERROR('MEMBER_CODES_LEGACY_PROFILE_OR_POINTS_REVIEW',16,1);
    EXEC dbo.SCCRM_AssertNoCustomerCodeReferences @Previous;
    -- Only the primary code changes. Original v1 link and 100 other non-PIN
    -- native columns remain unchanged; native bill/point owners never change.
    UPDATE dbo.TCNMCst SET FTCstCode=@HqCode WHERE FTCstCode=@Previous;
    IF @@ROWCOUNT<>1 RAISERROR('MEMBER_CODES_MIGRATION_WRITE_REFUSED',16,1);
    INSERT dbo.SCCRM_MemberCodeAliases(previous_code,member_id,assignment_id,ada_code,hq_identity,target_identity,
     profile_name,profile_phone,profile_email,profile_hash,assignment_hash,created_at)
    VALUES(@Previous,@MemberId,@AssignmentId,@HqCode,'__HQ_IDENTITY__',@TargetIdentity,@Name,@Phone,@Email,@ProfileHash,@AssignmentHash,GETUTCDATE());
    SET @Outcome='migrated';
   END
   ELSE RAISERROR('MEMBER_CODES_ASSIGNMENT_KIND_REFUSED',16,1);
   INSERT dbo.SCCRM_MemberCodeReceipts(assignment_id,member_id,ada_code,target_identity,profile_hash,assignment_hash,received_at)
    VALUES(@AssignmentId,@MemberId,@HqCode,@TargetIdentity,@ProfileHash,@AssignmentHash,GETUTCDATE());
  END;
  COMMIT;
 END TRY
 BEGIN CATCH
  SET @Error=ERROR_MESSAGE();SET @Number=ERROR_NUMBER();IF XACT_STATE()<>0 ROLLBACK;
  IF @Error LIKE 'MEMBER[_]CODES[_]%' AND @Error NOT LIKE '%[^A-Z_]%' RAISERROR(@Error,16,1);
  ELSE IF @Number IN(1205,1222) RAISERROR('MEMBER_CODES_BUSY',16,1);
  ELSE IF @Number IN(2601,2627) RAISERROR('MEMBER_CODES_UNOWNED_CODE_COLLISION_REVIEW',16,1);
  ELSE RAISERROR('MEMBER_CODES_RECEIVE_FAILED',16,1);
  RETURN;
 END CATCH;
 SELECT LOWER(CONVERT(varchar(36),r.assignment_id)) assignment_id,LOWER(CONVERT(varchar(36),r.member_id)) member_id,
  a.ada_code hq_code,r.ada_code,r.ada_code canonical_ada_code,a.previous_code,a.assignment_kind,r.target_identity,
  CONVERT(nvarchar(200),c.FTCstName) profile_name,c.FTCstTel profile_phone,
  CONVERT(nvarchar(100),ISNULL(c.FTCstEmail,'')) profile_email,r.profile_hash,r.assignment_hash,@Outcome outcome,
  CONVERT(varchar(23),r.received_at,126)+'Z' received_at,
  CONVERT(varchar(10),c.FDCstCrdIssue,23) card_issue_date,CONVERT(varchar(10),c.FDCstCrdExpire,23) card_expiry_date,
  CASE WHEN ISNULL(c.FTCstStaActive,'')<>'2' AND c.FDCstCrdExpire>=@Issue THEN 1 ELSE 0 END native_lookup_eligible
 FROM dbo.SCCRM_MemberCodeReceipts r JOIN dbo.SCCRM_MemberCodeApprovals a ON a.assignment_id=r.assignment_id
 JOIN dbo.TCNMCst c ON c.FTCstCode=r.ada_code WHERE r.assignment_id=@AssignmentId;
END;
