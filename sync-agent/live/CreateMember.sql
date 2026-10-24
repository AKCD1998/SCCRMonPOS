CREATE PROCEDURE dbo.SCCRM_CreateMemberFromSccrm
 @MemberId uniqueidentifier,@Name nvarchar(200),@Phone varchar(30),@Email nvarchar(100)
AS
BEGIN
 SET NOCOUNT ON;SET XACT_ABORT ON;SET LOCK_TIMEOUT 1000;
 IF DB_NAME()<>'__DATABASE__' OR IS_SRVROLEMEMBER('sysadmin')<>0 BEGIN RAISERROR('LIVE_MEMBER_TARGET_REFUSED',16,1);RETURN;END;
 IF NOT EXISTS(SELECT 1 FROM sys.extended_properties WHERE class=1 AND major_id=OBJECT_ID('dbo.SCCRM_LiveMemberLink') AND name='SCCRM_LiveSyncMarker' AND CONVERT(nvarchar(36),value)='ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b') BEGIN RAISERROR('LIVE_MEMBER_TARGET_REFUSED',16,1);RETURN;END;
 IF @MemberId IS NULL OR LEN(LTRIM(RTRIM(@Name)))=0 OR LEN(@Phone)<>10 OR @Phone LIKE '%[^0-9]%' OR LEFT(@Phone,1)<>'0'
 OR CONVERT(varbinary(max),CONVERT(nvarchar(max),CONVERT(varchar(200),@Name COLLATE Thai_CI_AS)))<>CONVERT(varbinary(max),@Name)
 OR CONVERT(varbinary(max),CONVERT(nvarchar(max),CONVERT(varchar(100),@Email COLLATE Thai_CI_AS)))<>CONVERT(varbinary(max),@Email)
 BEGIN RAISERROR('PROFILE_NOT_REPRESENTABLE',16,1);RETURN;END;
 DECLARE @Code varchar(20),@Existing varchar(20),@LockResult int;
 SET @Code='SC-'+UPPER(LEFT(REPLACE(CONVERT(varchar(36),@MemberId),'-',''),16));
 BEGIN TRAN;
 EXEC @LockResult=sys.sp_getapplock @Resource='SCCRM_LiveMemberCreate',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=1000;
 IF @LockResult<0 BEGIN ROLLBACK;RAISERROR('MEMBER_CREATE_BUSY',16,1);RETURN;END;
 SELECT @Existing=ada_code FROM dbo.SCCRM_LiveMemberLink WITH(UPDLOCK,HOLDLOCK) WHERE member_id=@MemberId;
 IF @Existing IS NOT NULL BEGIN COMMIT;SELECT @Existing ada_code,CONVERT(varchar(36),@MemberId) member_id,'existing' outcome;RETURN;END;
 IF EXISTS(SELECT 1 FROM dbo.TCNMCst WITH(UPDLOCK,HOLDLOCK) WHERE FTCstCode=@Code)
 BEGIN ROLLBACK;RAISERROR('CUSTOMER_CODE_COLLISION_REVIEW',16,1);RETURN;END;
 IF EXISTS(SELECT 1 FROM dbo.TCNMCst WITH(UPDLOCK,HOLDLOCK) WHERE
 REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(FTCstTel,''),' ',''),'-',''),'(',''),')','') LIKE '%'+@Phone+'%'
 OR REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(FTCstTel,''),' ',''),'-',''),'(',''),')','') LIKE '%66'+SUBSTRING(@Phone,2,9)+'%')
 BEGIN ROLLBACK;RAISERROR('EXISTING_CUSTOMER_REVIEW_REQUIRED',16,1);RETURN;END;
 INSERT dbo.TCNMCst(FTCstCode,FTCstName,FTCstTel,FTCstEmail,FTBchCode,FTCstStaActive,FCCstRetPoint,FCCstRetAmt,FCCstWhsPoint,FCCstDailyPoint,FDDateIns,FTTimeIns,FTWhoIns,FDDateUpd,FTTimeUpd,FTWhoUpd)
 VALUES(@Code,CONVERT(varchar(200),@Name),@Phone,CONVERT(varchar(100),@Email),'000','1',0,0,0,0,GETDATE(),CONVERT(varchar(8),GETDATE(),108),'SCCRM_SYNC_CREATE',GETDATE(),CONVERT(varchar(8),GETDATE(),108),'SCCRM_SYNC_CREATE');
 INSERT dbo.SCCRM_LiveMemberLink(member_id,ada_code,created_at,profile_name,profile_phone,profile_email) VALUES(@MemberId,@Code,GETDATE(),@Name,@Phone,@Email);
 COMMIT;
 SELECT @Code ada_code,CONVERT(varchar(36),@MemberId) member_id,'created' outcome;
END;
