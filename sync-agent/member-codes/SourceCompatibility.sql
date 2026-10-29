-- Operator applies this wrapper LAST, after native/queue/copy acceptance.
-- Existing signature and legacy error names remain compatible with liveworker.
CREATE PROCEDURE dbo.SCCRM_CreateMemberFromSccrm
 @MemberId uniqueidentifier,@Name nvarchar(200),@Phone varchar(30),@Email nvarchar(100)
AS
BEGIN
 SET NOCOUNT ON;SET XACT_ABORT ON;SET LOCK_TIMEOUT 1000;SET DEADLOCK_PRIORITY LOW;
 DECLARE @Legacy varchar(20),@Lock int,@Error nvarchar(4000),@Number int;
 BEGIN TRY
  EXEC dbo.SCCRM_AssertMemberCodeScope 'hq';
  IF @MemberId IS NULL RAISERROR('PROFILE_NOT_REPRESENTABLE',16,1);
  IF NOT EXISTS(SELECT 1 FROM sys.extended_properties WHERE class=1 AND major_id=OBJECT_ID('dbo.SCCRM_LiveMemberLink')
   AND name='SCCRM_LiveSyncMarker' AND CONVERT(nvarchar(36),value)='ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b')
   RAISERROR('LIVE_MEMBER_TARGET_REFUSED',16,1);
  BEGIN TRAN;
  EXEC @Lock=sys.sp_getapplock @Resource='SCCRM_LiveMemberCreate',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=1000;
  IF @Lock<0 RAISERROR('MEMBER_CREATE_BUSY',16,1);
  -- Keep unassigned legacy members, including the held synthetic fixture, on
  -- their original code. This path never creates/migrates/updates a customer.
  SELECT @Legacy=l.ada_code FROM dbo.SCCRM_LiveMemberLink l WITH(UPDLOCK,HOLDLOCK)
  WHERE l.member_id=@MemberId AND l.ada_code='SC-'+UPPER(LEFT(REPLACE(CONVERT(varchar(36),@MemberId),'-',''),16))
   AND NOT EXISTS(SELECT 1 FROM dbo.SCCRM_MemberCodeAssignments a WITH(UPDLOCK,HOLDLOCK) WHERE a.member_id=@MemberId);
  COMMIT;
  IF @Legacy IS NOT NULL
  BEGIN SELECT @Legacy ada_code,CONVERT(varchar(36),@MemberId) member_id,'existing' outcome;RETURN;END;
  EXEC dbo.SCCRM_CreateMemberFromSccrmV2 @MemberId,@Name,@Phone,@Email;
 END TRY
 BEGIN CATCH
  SET @Error=ERROR_MESSAGE();SET @Number=ERROR_NUMBER();IF XACT_STATE()<>0 ROLLBACK;
  IF @Number IN(1205,1222) OR @Error IN('MEMBER_CODES_BUSY','MEMBER_CREATE_BUSY') RAISERROR('MEMBER_CREATE_BUSY',16,1);
  ELSE IF @Error IN('MEMBER_CODES_EXISTING_CUSTOMER_REVIEW','EXISTING_CUSTOMER_REVIEW_REQUIRED') RAISERROR('EXISTING_CUSTOMER_REVIEW_REQUIRED',16,1);
  ELSE IF @Error IN('MEMBER_CODES_PROFILE_NOT_REPRESENTABLE','PROFILE_NOT_REPRESENTABLE') RAISERROR('PROFILE_NOT_REPRESENTABLE',16,1);
  ELSE IF @Error IN('MEMBER_CODES_ALLOCATION_COLLISION_REVIEW','MEMBER_CODES_SEQUENCE_EXHAUSTED_REVIEW') RAISERROR('CUSTOMER_CODE_COLLISION_REVIEW',16,1);
  ELSE IF @Error LIKE 'MEMBER[_]CODES[_]%' AND @Error NOT LIKE '%[^A-Z_]%' RAISERROR(@Error,16,1);
  ELSE RAISERROR('LIVE_MEMBER_TARGET_REFUSED',16,1);
 END CATCH;
END;
