CREATE PROCEDURE dbo.SCCRM_ReceiveMemberFromHq
 @MemberId uniqueidentifier,
 @HqCode varchar(max),
 @Name nvarchar(max),
 @Phone varchar(max),
 @Email nvarchar(max),
 @ProfileHash varchar(max),
 @TargetIdentity varchar(max)
AS
BEGIN
 SET NOCOUNT ON;
 SET XACT_ABORT ON;
 SET LOCK_TIMEOUT 1000;
 SET DEADLOCK_PRIORITY LOW;

 -- The provisioner replaces only validated literal placeholders. No caller
 -- controls a database, table, column, login, or dynamic SQL identifier.
 IF DB_NAME()<>'__DATABASE__'
 OR CONVERT(nvarchar(128),SERVERPROPERTY('MachineName'))<>N'__MACHINE__'
 OR IS_SRVROLEMEMBER('sysadmin')<>0
 BEGIN RAISERROR('FANOUT_TARGET_IDENTITY_REFUSED',16,1);RETURN;END;
 __COPY_GUARD__
 IF NOT EXISTS(
   SELECT 1 FROM sys.extended_properties
   WHERE class=1 AND major_id=OBJECT_ID('dbo.SCCRM_FanoutTarget')
     AND name='SCCRM_FanoutMarker'
     AND CONVERT(nvarchar(36),value)='86bfa892-2f57-4f60-a3f8-10b90ab5c7a9'
 ) OR NOT EXISTS(
   SELECT 1 FROM dbo.SCCRM_FanoutTarget
   WHERE singleton=1 AND marker='86bfa892-2f57-4f60-a3f8-10b90ab5c7a9'
     AND CONVERT(varbinary(max),target_identity)=CONVERT(varbinary(max),'__TARGET_IDENTITY__')
     AND database_name=N'__DATABASE__' AND machine_name=N'__MACHINE__'
     AND branch_code='__TARGET_BRANCH__'
 )
 BEGIN RAISERROR('FANOUT_TARGET_MARKER_REFUSED',16,1);RETURN;END;

 SET @Email=ISNULL(@Email,N'');
 IF @MemberId IS NULL OR @HqCode IS NULL OR DATALENGTH(@HqCode)>20
 OR @Name IS NULL OR LEN(LTRIM(RTRIM(@Name)))=0 OR DATALENGTH(@Name)>400
 OR CONVERT(varbinary(max),@Name)<>CONVERT(varbinary(max),LTRIM(RTRIM(@Name)))
 OR @Phone IS NULL OR DATALENGTH(@Phone)<>10
 OR @Phone COLLATE Latin1_General_BIN LIKE '%[^0-9]%' OR LEFT(@Phone,1)<>'0'
 OR DATALENGTH(@Email)>200
 OR @ProfileHash IS NULL OR DATALENGTH(@ProfileHash)<>64
 OR @ProfileHash COLLATE Latin1_General_BIN LIKE '%[^0-9a-f]%'
 OR @TargetIdentity IS NULL OR DATALENGTH(@TargetIdentity)>160
 OR CONVERT(varbinary(max),@TargetIdentity)<>CONVERT(varbinary(max),'__TARGET_IDENTITY__')
 OR CONVERT(varbinary(max),CONVERT(nvarchar(max),CONVERT(varchar(200),@Name COLLATE Thai_CI_AS)))<>CONVERT(varbinary(max),@Name)
 OR CONVERT(varbinary(max),CONVERT(nvarchar(max),CONVERT(varchar(100),@Email COLLATE Thai_CI_AS)))<>CONVERT(varbinary(max),@Email)
 BEGIN RAISERROR('FANOUT_PROFILE_NOT_REPRESENTABLE',16,1);RETURN;END;

 DECLARE @ExpectedCode varchar(20),@ExistingCode varchar(20),@LockResult int;
 DECLARE @Outcome varchar(20),@Error nvarchar(4000),@Number int;
 SET @ExpectedCode='SC-'+UPPER(LEFT(REPLACE(CONVERT(varchar(36),@MemberId),'-',''),16));
 IF CONVERT(varbinary(max),@ExpectedCode)<>CONVERT(varbinary(max),@HqCode)
 BEGIN RAISERROR('FANOUT_HQ_MEMBER_CODE_REFUSED',16,1);RETURN;END;

 BEGIN TRY
  BEGIN TRAN;
  EXEC @LockResult=sys.sp_getapplock
   @Resource='SCCRM_FanoutMemberCreate',@LockMode='Exclusive',
   @LockOwner='Transaction',@LockTimeout=1000;
  IF @LockResult<0 BEGIN RAISERROR('FANOUT_RECEIVER_BUSY',16,1);END;

  SELECT @ExistingCode=ada_code
  FROM dbo.SCCRM_FanoutMemberLink WITH(UPDLOCK,HOLDLOCK)
  WHERE member_id=@MemberId;
  IF @ExistingCode IS NOT NULL
  BEGIN
   IF NOT EXISTS(
    SELECT 1 FROM dbo.SCCRM_FanoutMemberLink
    WHERE member_id=@MemberId
     AND CONVERT(varbinary(max),hq_code)=CONVERT(varbinary(max),@HqCode)
     AND CONVERT(varbinary(max),ada_code)=CONVERT(varbinary(max),@HqCode)
     AND CONVERT(varbinary(max),target_identity)=CONVERT(varbinary(max),@TargetIdentity)
     AND CONVERT(varbinary(max),profile_name)=CONVERT(varbinary(max),@Name)
     AND CONVERT(varbinary(max),profile_phone)=CONVERT(varbinary(max),@Phone)
     AND CONVERT(varbinary(max),profile_email)=CONVERT(varbinary(max),@Email)
     AND CONVERT(varbinary(max),profile_hash)=CONVERT(varbinary(max),@ProfileHash)
   ) BEGIN RAISERROR('FANOUT_ACK_BASIS_CHANGED_REVIEW',16,1);END;
   IF NOT EXISTS(SELECT 1 FROM dbo.TCNMCst WITH(UPDLOCK,HOLDLOCK) WHERE FTCstCode=@ExistingCode)
   BEGIN RAISERROR('FANOUT_NATIVE_ROW_MISSING_REVIEW',16,1);END;
   IF NOT EXISTS(
    SELECT 1 FROM dbo.TCNMCst
    WHERE FTCstCode=@ExistingCode
     AND CONVERT(varbinary(max),CONVERT(nvarchar(200),ISNULL(FTCstName,'')))=CONVERT(varbinary(max),@Name)
     AND CONVERT(varbinary(max),ISNULL(FTCstTel,''))=CONVERT(varbinary(max),@Phone)
     AND CONVERT(varbinary(max),CONVERT(nvarchar(100),ISNULL(FTCstEmail,'')))=CONVERT(varbinary(max),@Email)
   ) BEGIN RAISERROR('FANOUT_NATIVE_PROFILE_CHANGED_REVIEW',16,1);END;
   SET @Outcome='existing';
  END
  ELSE
  BEGIN
   IF EXISTS(SELECT 1 FROM dbo.SCCRM_FanoutMemberLink WITH(UPDLOCK,HOLDLOCK) WHERE hq_code=@HqCode OR ada_code=@HqCode)
   BEGIN RAISERROR('FANOUT_MAPPING_COLLISION_REVIEW',16,1);END;
   IF EXISTS(SELECT 1 FROM dbo.TCNMCst WITH(UPDLOCK,HOLDLOCK) WHERE FTCstCode=@HqCode)
   BEGIN RAISERROR('FANOUT_CUSTOMER_CODE_COLLISION_REVIEW',16,1);END;
   -- A matching native phone is a review reason, never evidence of identity.
   -- Hold the checked range until insert; all receiver transactions share the
   -- same short application-lock/lock-wait budget. Ordinary readers may proceed.
   IF EXISTS(
    SELECT 1 FROM dbo.TCNMCst WITH(UPDLOCK,HOLDLOCK)
    WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(FTCstTel,''),' ',''),'-',''),'(',''),')',''),'+',''),'.','') LIKE '%'+@Phone+'%'
       OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(FTCstTel,''),' ',''),'-',''),'(',''),')',''),'+',''),'.','') LIKE '%66'+SUBSTRING(@Phone,2,9)+'%'
   ) BEGIN RAISERROR('FANOUT_EXISTING_CUSTOMER_REVIEW_REQUIRED',16,1);END;

   -- New profiles only. HQ home branch 000 and zero opening points are retained;
   -- there is no native UPDATE/DELETE, bill change, or points-transfer operation.
   INSERT dbo.TCNMCst(
    FTCstCode,FTCstName,FTCstTel,FTCstEmail,FTBchCode,FTCstStaActive,
    FCCstRetPoint,FCCstRetAmt,FCCstWhsPoint,FCCstDailyPoint,
    FDDateIns,FTTimeIns,FTWhoIns,FDDateUpd,FTTimeUpd,FTWhoUpd
   ) VALUES(
    @HqCode,CONVERT(varchar(200),@Name COLLATE Thai_CI_AS),@Phone,
    CONVERT(varchar(100),@Email COLLATE Thai_CI_AS),'000','1',0,0,0,0,
    GETDATE(),CONVERT(varchar(8),GETDATE(),108),'SCCRM_FANOUT_CREATE',
    GETDATE(),CONVERT(varchar(8),GETDATE(),108),'SCCRM_FANOUT_CREATE'
   );
   IF @@ROWCOUNT<>1 BEGIN RAISERROR('FANOUT_NATIVE_INSERT_NOT_CONFIRMED',16,1);END;
   INSERT dbo.SCCRM_FanoutMemberLink(
    member_id,hq_code,ada_code,target_identity,profile_name,profile_phone,
    profile_email,profile_hash,received_at
   ) VALUES(@MemberId,@HqCode,@HqCode,@TargetIdentity,@Name,@Phone,@Email,@ProfileHash,GETUTCDATE());
   SET @Outcome='created';
  END;
  COMMIT;
 END TRY
 BEGIN CATCH
  SET @Error=ERROR_MESSAGE();SET @Number=ERROR_NUMBER();
  IF XACT_STATE()<>0 ROLLBACK;
  IF @Error LIKE 'FANOUT[_]%' AND @Error NOT LIKE '%[^A-Z_]%'
   RAISERROR(@Error,16,1);
  ELSE IF @Number IN(1205,1222)
   RAISERROR('FANOUT_RECEIVER_BUSY',16,1);
  ELSE IF @Number IN(2601,2627)
   RAISERROR('FANOUT_CUSTOMER_CODE_COLLISION_REVIEW',16,1);
  ELSE
   RAISERROR('FANOUT_RECEIVE_FAILED',16,1);
  RETURN;
 END CATCH;

 -- Return actual native values. The caller independently hashes these fields;
 -- profile_hash is an immutable caller digest, not an SQL2008 SHA256 claim.
 SELECT CONVERT(varchar(36),l.member_id) AS member_id,l.hq_code,l.ada_code,
  l.target_identity,CONVERT(nvarchar(200),c.FTCstName) AS profile_name,
  c.FTCstTel AS profile_phone,CONVERT(nvarchar(100),ISNULL(c.FTCstEmail,'')) AS profile_email,
  l.profile_hash,@Outcome AS outcome,CONVERT(varchar(23),l.received_at,126)+'Z' AS received_at
 FROM dbo.SCCRM_FanoutMemberLink l JOIN dbo.TCNMCst c ON c.FTCstCode=l.ada_code
 WHERE l.member_id=@MemberId;
END;
