CREATE PROCEDURE dbo.SCCRM_ApplyPointProjection
 @OperationId uniqueidentifier,@AdaCode varchar(20),@TargetBalance bigint,
 @ExpectedIntrinsicBalance float,@Revision char(64),@Generation bigint
AS
BEGIN
 SET NOCOUNT ON;SET XACT_ABORT ON;SET DEADLOCK_PRIORITY LOW;SET LOCK_TIMEOUT 1000;
 DECLARE @Current float,@Intrinsic float,@Owned bigint,@Delta bigint,@Doc varchar(30),@Kind varchar(1),@LockResult int;
 IF DB_NAME()<>'__DATABASE__' OR NOT EXISTS(SELECT 1 FROM dbo.SCCRM_PointSyncMeta WHERE singleton=1
  AND marker='238ecf14-fda8-46a8-bc34-d663659b2202' AND target_identity='__IDENTITY__' AND branch_code='__BRANCH__')
 BEGIN RAISERROR('POINT_RECEIVER_IDENTITY_REFUSED',16,1);RETURN;END;
 IF @AdaCode IS NULL OR @Revision IS NULL OR @ExpectedIntrinsicBalance IS NULL OR @TargetBalance IS NULL
  OR @Generation IS NULL OR @Generation<1 OR @Generation>9007199254740991 OR @OperationId IS NULL
  OR @ExpectedIntrinsicBalance<>ROUND(@ExpectedIntrinsicBalance,0) OR ABS(@ExpectedIntrinsicBalance)>9007199254740991
  OR LEN(@AdaCode)<1 OR LEN(@AdaCode)>20 OR @Revision LIKE '%[^a-f0-9]%' OR LEN(@Revision)<>64
  OR @TargetBalance>9007199254740991 OR @TargetBalance< -9007199254740991
 BEGIN RAISERROR('POINT_RECEIVER_INPUT_REFUSED',16,1);RETURN;END;
 BEGIN TRY
  BEGIN TRANSACTION;
  EXEC @LockResult=sys.sp_getapplock @Resource='SCCRM-AdaPoint-Projection',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=0;
  IF @LockResult<0 RAISERROR('POINT_RECEIVER_BUSY',16,1);
  IF EXISTS(SELECT 1 FROM dbo.SCCRM_PointSyncReceipts WHERE operation_id=@OperationId)
  BEGIN
   IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_PointSyncReceipts WHERE operation_id=@OperationId AND ada_code=@AdaCode
    AND target_balance=@TargetBalance AND expected_intrinsic=@ExpectedIntrinsicBalance AND revision=@Revision AND generation=@Generation)
    RAISERROR('POINT_RECEIVER_OPERATION_REUSED',16,1);
   COMMIT TRANSACTION;
   SELECT LOWER(CONVERT(varchar(36),operation_id)) operation_id,ada_code,ref_doc,delta_points,target_balance,generation,revision,'__IDENTITY__' target_identity,'replayed' outcome
    FROM dbo.SCCRM_PointSyncReceipts WHERE operation_id=@OperationId;
   RETURN;
  END;
  IF EXISTS(SELECT 1 FROM dbo.SCCRM_PointSyncHeads WITH(UPDLOCK,HOLDLOCK) WHERE ada_code=@AdaCode AND last_generation>=@Generation)
  BEGIN
   IF EXISTS(SELECT 1 FROM dbo.SCCRM_PointSyncHeads WHERE ada_code=@AdaCode AND last_generation=@Generation
    AND(last_revision<>@Revision OR last_target<>@TargetBalance)) RAISERROR('POINT_RECEIVER_GENERATION_REUSED',16,1);
   COMMIT TRANSACTION;
   SELECT LOWER(CONVERT(varchar(36),@OperationId)) operation_id,@AdaCode ada_code,@TargetBalance target_balance,@Generation generation,
    @Revision revision,'__IDENTITY__' target_identity,'superseded' outcome;
   RETURN;
  END;
  IF NOT EXISTS(SELECT 1 FROM dbo.TCNMCst WITH(UPDLOCK,HOLDLOCK) WHERE FTCstCode=@AdaCode)
   RAISERROR('POINT_RECEIVER_MEMBER_MISSING',16,1);
  -- Owned projection entries must still be exactly the append-only rows this
  -- receiver wrote. A vendor expiry/month-end/edit is held, never guessed.
  IF EXISTS(SELECT 1 FROM dbo.SCCRM_PointSyncReceipts r LEFT JOIN dbo.TCNTCstPoint p WITH(UPDLOCK,HOLDLOCK)
    ON p.FTBchCode=r.branch_code AND p.FTCstCode=r.ada_code AND p.FTPntRefDoc=r.ref_doc AND p.FTSplCode=''
    WHERE r.ada_code=@AdaCode AND r.delta_points<>0 AND(p.FTCstCode IS NULL OR p.FNPntPoint IS NULL OR p.FNPntPoint<>ABS(r.delta_points)
     OR ISNULL(p.FTPntCardType,'')<>CASE WHEN r.delta_points>0 THEN '1' ELSE '2' END OR ISNULL(p.FTPntExpired,'')<>'N'
     OR ISNULL(p.FTPntStaPrcDoc,'')<>'N' OR ISNULL(p.FTWhoIns,'')<>'SCCRM_POINT_SYNC_V1' OR p.FCPntAmtRcv IS NULL OR p.FCPntAmtRcv<>0
     OR p.FCPntPointbyOne IS NULL OR p.FCPntPointbyOne<>0 OR p.FNPntPointOld IS NULL
     OR p.FNPntPointOld<>CONVERT(bigint,r.previous_balance))) RAISERROR('POINT_RECEIVER_OWNED_ROW_CHANGED',16,1);
  SELECT @Current=FNPntPoint FROM dbo.VCN_TCNMPdtCstPointAmt WHERE FTCstCode=@AdaCode;
  SELECT @Owned=ISNULL(SUM(delta_points),0) FROM dbo.SCCRM_PointSyncReceipts WHERE ada_code=@AdaCode;
  IF ABS(CONVERT(decimal(38,0),@Owned))>9007199254740991 RAISERROR('POINT_RECEIVER_OWNED_SUM_UNREPRESENTABLE',16,1);
  IF @Current IS NULL OR @Current<>ROUND(@Current,0) OR ABS(@Current)>9007199254740991
   RAISERROR('POINT_RECEIVER_BALANCE_UNREPRESENTABLE',16,1);
  SET @Intrinsic=@Current-CONVERT(float,@Owned);
  IF ABS(@Intrinsic)>9007199254740991 OR @Intrinsic<>ROUND(@Intrinsic,0) RAISERROR('POINT_RECEIVER_INTRINSIC_UNREPRESENTABLE',16,1);
  IF @Intrinsic<>@ExpectedIntrinsicBalance RAISERROR('POINT_RECEIVER_SOURCE_MOVED_RETRY',16,1);
  SET @Delta=@TargetBalance-CONVERT(bigint,@Current);
  IF ABS(CONVERT(decimal(38,0),@Delta))>9007199254740991 RAISERROR('POINT_RECEIVER_DELTA_UNREPRESENTABLE',16,1);
  SET @Doc='SP'+LEFT(REPLACE(CONVERT(varchar(36),@OperationId),'-',''),28);
  IF EXISTS(SELECT 1 FROM dbo.TCNTCstPoint WHERE FTBchCode='__BRANCH__' AND FTCstCode=@AdaCode AND FTPntRefDoc=@Doc AND FTSplCode='')
   RAISERROR('POINT_RECEIVER_REFERENCE_COLLISION',16,1);
  IF @Delta<>0
  BEGIN
   SET @Kind=CASE WHEN @Delta>0 THEN '1' ELSE '2' END;
   INSERT dbo.TCNTCstPoint(FTBchCode,FTCstCode,FTPntRefDoc,FTSplCode,FDPntDate,FCPntPointbyOne,FCPntAmtRcv,
    FNPntPoint,FNPntPointOld,FTPntExpired,FTPntStaPrcDoc,FTPntCardType,FTCptTime,FDDateIns,FTTimeIns,FTWhoIns)
   VALUES('__BRANCH__',@AdaCode,@Doc,'',GETDATE(),0,0,ABS(@Delta),CONVERT(bigint,@Current),'N','N',@Kind,
    CONVERT(varchar(8),GETDATE(),108),GETDATE(),CONVERT(varchar(8),GETDATE(),108),'SCCRM_POINT_SYNC_V1');
  END;
  INSERT dbo.SCCRM_PointSyncReceipts(operation_id,ada_code,branch_code,ref_doc,revision,generation,expected_intrinsic,
   previous_balance,target_balance,delta_points,created_at)
  VALUES(@OperationId,@AdaCode,'__BRANCH__',@Doc,@Revision,@Generation,@ExpectedIntrinsicBalance,@Current,@TargetBalance,@Delta,GETUTCDATE());
  UPDATE dbo.SCCRM_PointSyncHeads SET last_generation=@Generation,last_revision=@Revision,last_target=@TargetBalance,last_operation=@OperationId WHERE ada_code=@AdaCode;
  IF @@ROWCOUNT=0 INSERT dbo.SCCRM_PointSyncHeads(ada_code,last_generation,last_revision,last_target,last_operation)
   VALUES(@AdaCode,@Generation,@Revision,@TargetBalance,@OperationId);
  SELECT @Current=FNPntPoint FROM dbo.VCN_TCNMPdtCstPointAmt WHERE FTCstCode=@AdaCode;
  IF @Current IS NULL OR @Current<>@TargetBalance RAISERROR('POINT_RECEIVER_READBACK_FAILED',16,1);
  COMMIT TRANSACTION;
  SELECT LOWER(CONVERT(varchar(36),operation_id)) operation_id,ada_code,ref_doc,delta_points,target_balance,generation,revision,'__IDENTITY__' target_identity,'applied' outcome
   FROM dbo.SCCRM_PointSyncReceipts WHERE operation_id=@OperationId;
 END TRY
 BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  DECLARE @Error nvarchar(2048);SET @Error=ERROR_MESSAGE();RAISERROR(@Error,16,1);
 END CATCH;
END;
