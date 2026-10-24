CREATE PROCEDURE dbo.SCCRM_BidiApplyProfile
 @Code varchar(20),@Name nvarchar(4000),@Phone nvarchar(4000),@Email nvarchar(4000),
 @ExpectedName nvarchar(4000),@ExpectedPhone nvarchar(4000),@ExpectedEmail nvarchar(4000)
AS
BEGIN
 SET NOCOUNT ON; SET XACT_ABORT ON;
 IF DB_NAME()<>'SCCRM_UiSandbox_20261024_142127'
 OR NOT EXISTS(SELECT 1 FROM sys.extended_properties WHERE name='SCCRM_SandboxMarker' AND CONVERT(nvarchar(36),value)='6d42574b-3e90-4d92-aa5d-4c4920a08cbe')
 BEGIN RAISERROR('SANDBOX_ONLY',16,1);RETURN;END;
 IF LEN(@Name) NOT BETWEEN 1 AND 200 OR LEN(@Phone) NOT BETWEEN 9 AND 30 OR LEN(@Email)>100
 BEGIN RAISERROR('PROFILE_NOT_REPRESENTABLE',16,1);RETURN;END;
 IF CONVERT(varbinary(max),CONVERT(nvarchar(max),CONVERT(varchar(200),@Name COLLATE Thai_CI_AS)))<>CONVERT(varbinary(max),@Name)
 OR CONVERT(varbinary(max),CONVERT(nvarchar(max),CONVERT(varchar(100),@Email COLLATE Thai_CI_AS)))<>CONVERT(varbinary(max),@Email)
 BEGIN RAISERROR('PROFILE_NOT_REPRESENTABLE',16,1);RETURN;END;
 IF @Email='' AND @ExpectedEmail<>'' BEGIN RAISERROR('BLANK_CANNOT_ERASE_EXISTING',16,1);RETURN;END;
 UPDATE dbo.TCNMCst SET FTCstName=CONVERT(varchar(200),@Name),FTCstTel=CONVERT(varchar(30),@Phone),
 FTCstEmail=NULLIF(CONVERT(varchar(100),@Email),''),FDDateUpd=GETDATE(),FTTimeUpd=CONVERT(varchar(8),GETDATE(),108),FTWhoUpd='SCCRM_BIDI_TEST'
 WHERE FTCstCode=@Code AND ISNULL(FTCstName,'')=@ExpectedName AND ISNULL(FTCstTel,'')=@ExpectedPhone AND ISNULL(FTCstEmail,'')=@ExpectedEmail;
 IF @@ROWCOUNT<>1 BEGIN RAISERROR('PROFILE_CHANGED_DURING_SYNC',16,1);RETURN;END;
 SELECT 'updated' AS outcome;
END;
GO
CREATE PROCEDURE dbo.SCCRM_BidiApplyPoint
 @ReceiptId uniqueidentifier,@EventKey nvarchar(200),@Code varchar(20),@TargetAmount bigint
AS
BEGIN
 SET NOCOUNT ON; SET XACT_ABORT ON;
 IF DB_NAME()<>'SCCRM_UiSandbox_20261024_142127'
 OR NOT EXISTS(SELECT 1 FROM sys.extended_properties WHERE name='SCCRM_SandboxMarker' AND CONVERT(nvarchar(36),value)='6d42574b-3e90-4d92-aa5d-4c4920a08cbe')
 BEGIN RAISERROR('SANDBOX_ONLY',16,1);RETURN;END;
 IF LEN(@EventKey) NOT BETWEEN 1 AND 200 OR @TargetAmount NOT BETWEEN -2147483647 AND 2147483647
 BEGIN RAISERROR('POINT_RANGE_REFUSED',16,1);RETURN;END;
 BEGIN TRY
  BEGIN TRANSACTION;
  DECLARE @PriorKey nvarchar(200),@PriorCode varchar(20),@PriorTarget bigint,@Applied bigint,@Delta bigint,@Branch varchar(6),@Balance bigint;
  SELECT @PriorKey=event_key,@PriorCode=ada_code,@PriorTarget=target_amount FROM dbo.SCCRM_BidiPointReceipt WITH(UPDLOCK,HOLDLOCK) WHERE receipt_id=@ReceiptId;
  IF @PriorKey IS NOT NULL
  BEGIN
   IF @PriorKey<>@EventKey OR @PriorCode<>@Code OR @PriorTarget<>@TargetAmount RAISERROR('RECEIPT_REUSE_REFUSED',16,1);
   COMMIT;SELECT 'duplicate' AS outcome,CAST(0 AS bigint) AS delta;RETURN;
  END;
  SELECT @PriorCode=ada_code,@Applied=applied_amount FROM dbo.SCCRM_BidiPointState WITH(UPDLOCK,HOLDLOCK) WHERE event_key=@EventKey;
  IF @Applied IS NOT NULL AND @PriorCode<>@Code RAISERROR('POINT_MEMBER_CHANGE_REFUSED',16,1);
  SET @Delta=@TargetAmount-ISNULL(@Applied,0);
  IF @Delta NOT BETWEEN -2147483647 AND 2147483647 RAISERROR('POINT_RANGE_REFUSED',16,1);
  SELECT @Branch=FTBchCode FROM dbo.TCNMCst WITH(UPDLOCK,HOLDLOCK) WHERE FTCstCode=@Code;
  IF @Branch IS NULL RAISERROR('MAPPED_CUSTOMER_MISSING',16,1);
  SELECT @Balance=FNPntPoint FROM dbo.VCN_TCNMPdtCstPointAmt WHERE FTCstCode=@Code;
  IF @Balance IS NULL RAISERROR('POINT_BASELINE_REQUIRED',16,1);
  IF @Balance+@Delta<0 RAISERROR('INSUFFICIENT_POINTS_REVIEW_REQUIRED',16,1);
  IF @Delta<>0
   INSERT dbo.TCNTCstPoint(FTBchCode,FTCstCode,FTPntRefDoc,FTSplCode,FDPntDate,FCPntPointbyOne,FCPntAmtRcv,FNPntPoint,FNPntPointOld,FTPntExpired,FTPntStaPrcDoc,FTPntCardType,FTCptTime,FDDateIns,FTTimeIns,FTWhoIns)
   VALUES(@Branch,@Code,'X'+LEFT(REPLACE(CONVERT(varchar(36),@ReceiptId),'-',''),29),'',GETDATE(),0,0,ABS(@Delta),@Balance,'N','N',CASE WHEN @Delta>0 THEN '1' ELSE '2' END,CONVERT(varchar(8),GETDATE(),108),GETDATE(),CONVERT(varchar(8),GETDATE(),108),'SCCRM_SYNC');
  IF @Applied IS NULL INSERT dbo.SCCRM_BidiPointState(event_key,ada_code,applied_amount) VALUES(@EventKey,@Code,@TargetAmount);
  ELSE UPDATE dbo.SCCRM_BidiPointState SET applied_amount=@TargetAmount WHERE event_key=@EventKey;
  INSERT dbo.SCCRM_BidiPointReceipt(receipt_id,event_key,ada_code,target_amount,applied_delta) VALUES(@ReceiptId,@EventKey,@Code,@TargetAmount,@Delta);
  COMMIT;SELECT 'applied' AS outcome,@Delta AS delta;
 END TRY
 BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK;
  DECLARE @Reason nvarchar(4000);SET @Reason=ERROR_MESSAGE();RAISERROR(@Reason,16,1);
 END CATCH;
END;
