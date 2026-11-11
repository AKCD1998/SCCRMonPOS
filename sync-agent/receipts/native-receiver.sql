CREATE PROCEDURE dbo.SCCRM_AttachReceiptMember
 @OperationId uniqueidentifier,@PayloadHash char(64),@AdaCode varchar(20),
 @Branch char(3),@Pos char(3),@Doc varchar(20),@SoldDate datetime,@SoldTime varchar(8),
 @Grand decimal(20,2),@ExpectedName nvarchar(255),@ExpectedPhone varchar(30),@Items xml
WITH EXECUTE AS OWNER
AS
BEGIN
 SET NOCOUNT ON;SET XACT_ABORT ON;SET DEADLOCK_PRIORITY LOW;SET LOCK_TIMEOUT 1000;
 IF DB_NAME()<>'__DATABASE__' OR NOT EXISTS(SELECT 1 FROM dbo.SCCRM_ReceiptSyncMeta WHERE singleton=1
  AND marker='ab01553b-576c-465e-af30-87daa20e2d33' AND target_branch='__TARGET__')
 BEGIN RAISERROR('RECEIPT_TARGET_REFUSED',16,1);RETURN;END;
 IF OBJECT_ID('dbo.SCCRM_ReceiptTimeAudit') IS NULL
 BEGIN RAISERROR('RECEIPT_TIME_AUDIT_REQUIRED',16,1);RETURN;END;
 IF @OperationId IS NULL OR @PayloadHash IS NULL OR LEN(@PayloadHash)<>64 OR @PayloadHash LIKE '%[^a-f0-9]%'
  OR @AdaCode IS NULL OR LEN(@AdaCode)<1 OR @AdaCode LIKE '%[^A-Z0-9-]%'
  OR @Branch NOT IN('001','003','004','005') OR @Pos IS NULL OR @Pos NOT IN('001','002')
  OR ('__TARGET__'<>'000' AND @Branch<>'__TARGET__')
  OR @Doc IS NULL OR LEN(@Doc)<1 OR @Doc LIKE '%[^A-Z0-9-]%'
  OR @Grand IS NULL OR @Grand<=0 OR @SoldDate IS NULL OR @SoldTime IS NULL
  OR @ExpectedName IS NULL OR LEN(LTRIM(RTRIM(@ExpectedName)))=0 OR @Items IS NULL
 BEGIN RAISERROR('RECEIPT_PACKET_REFUSED',16,1);RETURN;END;
 CREATE TABLE #Expected(seq bigint PRIMARY KEY,sku varchar(255),barcode varchar(128),unit varchar(50),unit_name nvarchar(100),
  qty decimal(28,6),price decimal(28,6),net decimal(28,6),discount decimal(28,6));
 INSERT #Expected SELECT n.value('@seq','bigint'),n.value('@sku','varchar(255)'),n.value('@barcode','varchar(128)'),
  n.value('@unit','varchar(50)'),n.value('@unitName','nvarchar(100)'),n.value('@qty','decimal(28,6)'),
  n.value('@price','decimal(28,6)'),n.value('@net','decimal(28,6)'),n.value('@discount','decimal(28,6)') FROM @Items.nodes('/items/i') t(n);
 IF NOT EXISTS(SELECT 1 FROM #Expected) OR (SELECT COUNT(*) FROM #Expected)>1000
  OR EXISTS(SELECT 1 FROM #Expected WHERE seq<=0 OR LEN(sku)=0 OR qty=0 OR price<0)
 BEGIN RAISERROR('RECEIPT_ITEMS_REFUSED',16,1);RETURN;END;
 CREATE TABLE #Observed(table_name varchar(20) PRIMARY KEY,sale_date datetime,sale_time varchar(8));
 DECLARE @Sql nvarchar(max),@Header sysname,@Detail sysname,@Number int,@Found int,@Changed int,@Writes int,
  @Tables varchar(100),@Replay bit,@Result int,@Resource nvarchar(255),@NativeDate datetime,@NativeTime varchar(8),
  @NativeTable varchar(20),@Adjusted bit,@Observations xml;
 SET @Found=0;SET @Writes=0;SET @Tables='';SET @Replay=0;
 BEGIN TRY
  BEGIN TRANSACTION;
  SET @Resource='SCCRM-Receipt-'+@Branch+'-'+@Doc;
  EXEC @Result=sys.sp_getapplock @Resource=@Resource,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=0;
  IF @Result<0 RAISERROR('RECEIPT_BUSY',16,1);
  IF NOT EXISTS(SELECT 1 FROM dbo.TCNMCst WHERE FTCstCode=@AdaCode
   AND LTRIM(RTRIM(CONVERT(nvarchar(255),FTCstName))) COLLATE Latin1_General_BIN2=LTRIM(RTRIM(@ExpectedName)) COLLATE Latin1_General_BIN2
   AND (@ExpectedPhone IS NULL OR ISNULL(LTRIM(RTRIM(FTCstTel)),'')=@ExpectedPhone))
   RAISERROR('RECEIPT_MEMBER_REQUIRES_REVIEW',16,1);
  IF EXISTS(SELECT 1 FROM dbo.SCCRM_ReceiptSyncJournal WHERE operation_id=@OperationId)
  BEGIN
   IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_ReceiptSyncJournal WHERE operation_id=@OperationId AND payload_hash=@PayloadHash
    AND ada_code=@AdaCode AND branch_code=@Branch AND pos_code=@Pos AND doc_no=@Doc)
    RAISERROR('RECEIPT_OPERATION_REUSED',16,1);
   SET @Replay=1;
  END;
  IF EXISTS(SELECT 1 FROM dbo.SCCRM_ReceiptSyncJournal WHERE branch_code=@Branch AND doc_no=@Doc
   AND(operation_id<>@OperationId OR ada_code<>@AdaCode OR payload_hash<>@PayloadHash))
   RAISERROR('RECEIPT_ALREADY_OWNED',16,1);
  DECLARE headers CURSOR LOCAL FAST_FORWARD FOR
   SELECT name FROM sys.tables WHERE schema_id=SCHEMA_ID('dbo') AND
    (name='TPSTSalHD' OR('__TARGET__'<>'000' AND name='TSHD'+@Pos)) ORDER BY name;
  OPEN headers;FETCH NEXT FROM headers INTO @Header;
  WHILE @@FETCH_STATUS=0
  BEGIN
   SET @Detail=CASE WHEN @Header='TPSTSalHD' THEN 'TPSTSalDT' ELSE 'TSDT'+@Pos END;
   IF OBJECT_ID('dbo.'+@Detail) IS NULL RAISERROR('RECEIPT_SCHEMA_REQUIRES_REVIEW',16,1);
   SET @Sql=N'SELECT @Number=COUNT(*) FROM dbo.'+QUOTENAME(@Header)+N' WITH(UPDLOCK,ROWLOCK)
    WHERE FTBchCode=@Branch AND FTPosCode=@Pos AND FTShdDocNo=@Doc;';
   SET @Number=0;
   EXEC sys.sp_executesql @Sql,N'@Branch char(3),@Pos char(3),@Doc varchar(20),@Number int OUTPUT',@Branch,@Pos,@Doc,@Number OUTPUT;
   IF @Number>1 RAISERROR('RECEIPT_AMBIGUOUS_HEADER',16,1);
   IF @Number=1
   BEGIN
    SET @Found=@Found+1;
    SET @Sql=N'
     IF NOT EXISTS(SELECT 1 FROM dbo.'+QUOTENAME(@Header)+N' WITH(UPDLOCK,ROWLOCK)
      WHERE FTBchCode=@Branch AND FTPosCode=@Pos AND FTShdDocNo=@Doc AND FTShdDocType=''1'')
      RAISERROR(''RECEIPT_DOCUMENT_KIND_CHANGED'',16,1);
     IF NOT EXISTS(SELECT 1 FROM dbo.'+QUOTENAME(@Header)+N' WHERE FTBchCode=@Branch AND FTPosCode=@Pos AND FTShdDocNo=@Doc
       AND FTShdStaPaid=''3'' AND FTShdStaDoc=''1'') RAISERROR(''RECEIPT_NOT_FINAL'',16,1);
     IF NOT EXISTS(SELECT 1 FROM dbo.'+QUOTENAME(@Header)+N' WHERE FTBchCode=@Branch AND FTPosCode=@Pos AND FTShdDocNo=@Doc
       AND FCShdGrand IS NOT NULL AND ABS(FCShdGrand-CONVERT(float,@Grand))<0.005)
      RAISERROR(''RECEIPT_FINANCIAL_HEADER_CHANGED'',16,1);
     IF EXISTS(SELECT 1 FROM dbo.'+QUOTENAME(@Header)+N' WHERE FTBchCode=@Branch AND FTPosCode=@Pos AND FTShdDocNo=@Doc
       AND NULLIF(LTRIM(RTRIM(ISNULL(FTCstCode,''''))),'''') IS NOT NULL AND FTCstCode<>@AdaCode)
      RAISERROR(''RECEIPT_OTHER_MEMBER'',16,1);
     IF (SELECT COUNT(*) FROM dbo.'+QUOTENAME(@Detail)+N' WHERE FTBchCode=@Branch AND FTShdDocNo=@Doc)<>(SELECT COUNT(*) FROM #Expected)
      RAISERROR(''RECEIPT_ITEMS_CHANGED'',16,1);
     IF EXISTS(SELECT 1 FROM #Expected e LEFT JOIN dbo.'+QUOTENAME(@Detail)+N' d
      ON d.FTBchCode=@Branch AND d.FTShdDocNo=@Doc AND d.FNSdtSeqNo=e.seq
      WHERE d.FNSdtSeqNo IS NULL OR ISNULL(LTRIM(RTRIM(d.FTPdtCode)),'''') COLLATE Latin1_General_BIN2<>e.sku
       OR ISNULL(LTRIM(RTRIM(d.FTSdtBarCode)),'''') COLLATE Latin1_General_BIN2<>e.barcode
       OR ISNULL(LTRIM(RTRIM(d.FTPunCode)),'''') COLLATE Latin1_General_BIN2<>e.unit
       OR ISNULL(LTRIM(RTRIM(CONVERT(nvarchar(100),d.FTSdtUnitName))),N'''') COLLATE Latin1_General_BIN2<>e.unit_name
       OR d.FCSdtQty IS NULL OR ABS(d.FCSdtQty-CONVERT(float,e.qty))>0.000001
       OR d.FCSdtSetPrice IS NULL OR ABS(d.FCSdtSetPrice-CONVERT(float,e.price))>0.000001
       OR d.FCSdtNet IS NULL OR ABS(d.FCSdtNet-CONVERT(float,e.net))>0.000001
       OR ABS(ISNULL(d.FCSdtDis,0)-CONVERT(float,e.discount))>0.000001)
      RAISERROR(''RECEIPT_ITEMS_CHANGED'',16,1);
     IF EXISTS(SELECT 1 FROM dbo.'+QUOTENAME(@Header)+N' WHERE FTBchCode=@Branch AND FTPosCode=@Pos AND FTShdDocNo=@Doc
       AND(FDShdDocDate IS NULL OR FTShdDocTime IS NULL OR LEN(FTShdDocTime)=0))
      RAISERROR(''RECEIPT_FINAL_TIME_UNAVAILABLE'',16,1);
     INSERT #Observed SELECT @TableName,CONVERT(datetime,CONVERT(char(10),FDShdDocDate,120),120),
       CONVERT(varchar(8),CONVERT(datetime,CONVERT(char(10),FDShdDocDate,120)+'' ''+FTShdDocTime,120),108)
       FROM dbo.'+QUOTENAME(@Header)+N' WHERE FTBchCode=@Branch AND FTPosCode=@Pos AND FTShdDocNo=@Doc;
     UPDATE dbo.'+QUOTENAME(@Header)+N' WITH(ROWLOCK) SET FTCstCode=@AdaCode
      WHERE FTBchCode=@Branch AND FTPosCode=@Pos AND FTShdDocNo=@Doc AND NULLIF(LTRIM(RTRIM(ISNULL(FTCstCode,''''))),'''') IS NULL;
     SET @Changed=@@ROWCOUNT;
     IF NOT EXISTS(SELECT 1 FROM dbo.'+QUOTENAME(@Header)+N' WHERE FTBchCode=@Branch AND FTPosCode=@Pos AND FTShdDocNo=@Doc AND FTCstCode=@AdaCode)
      RAISERROR(''RECEIPT_READBACK_FAILED'',16,1);';
    SET @Changed=0;
    EXEC sys.sp_executesql @Sql,N'@Branch char(3),@Pos char(3),@Doc varchar(20),@AdaCode varchar(20),@Grand decimal(20,2),@TableName varchar(20),@Changed int OUTPUT',
     @Branch,@Pos,@Doc,@AdaCode,@Grand,@Header,@Changed OUTPUT;
    SET @Writes=@Writes+@Changed;SET @Tables=@Tables+CASE WHEN LEN(@Tables)=0 THEN '' ELSE ',' END+@Header;
   END;
   FETCH NEXT FROM headers INTO @Header;
  END;
  CLOSE headers;DEALLOCATE headers;
  IF @Found=0 RAISERROR('RECEIPT_NOT_ARRIVED',16,1);
  -- The origin's finalized POS table is authoritative while present; retain
  -- every native observation in the audit. Never rewrite native date/time.
  SELECT TOP(1) @NativeDate=sale_date,@NativeTime=sale_time,@NativeTable=table_name FROM #Observed
   ORDER BY CASE WHEN table_name='TSHD'+@Pos THEN 0 ELSE 1 END,table_name;
  SET @Adjusted=CASE WHEN CONVERT(varchar(10),@NativeDate,120)<>CONVERT(varchar(10),@SoldDate,120) OR @NativeTime<>@SoldTime THEN 1 ELSE 0 END;
  SET @Observations=(SELECT table_name,sale_date,sale_time FROM #Observed ORDER BY table_name FOR XML PATH('header'),ROOT('headers'),TYPE);
  IF EXISTS(SELECT 1 FROM dbo.SCCRM_ReceiptTimeAudit WHERE operation_id=@OperationId)
  BEGIN
   IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_ReceiptTimeAudit WHERE operation_id=@OperationId AND payload_hash=@PayloadHash
    AND submitted_date=@SoldDate AND submitted_time=@SoldTime AND native_date=@NativeDate AND native_time=@NativeTime)
    RAISERROR('RECEIPT_CANONICAL_TIME_CHANGED',16,1);
  END ELSE INSERT dbo.SCCRM_ReceiptTimeAudit(operation_id,payload_hash,submitted_date,submitted_time,native_date,native_time,native_time_table,time_adjusted,observations,recorded_at)
   VALUES(@OperationId,@PayloadHash,@SoldDate,@SoldTime,@NativeDate,@NativeTime,@NativeTable,@Adjusted,@Observations,GETUTCDATE());
  IF @Replay=0 INSERT dbo.SCCRM_ReceiptSyncJournal(operation_id,payload_hash,ada_code,branch_code,pos_code,doc_no,created_at)
   VALUES(@OperationId,@PayloadHash,@AdaCode,@Branch,@Pos,@Doc,GETUTCDATE());
  COMMIT TRANSACTION;
  SELECT LOWER(CONVERT(varchar(36),@OperationId)) operation_id,@PayloadHash payload_hash,@AdaCode ada_code,
   @Doc doc_no,@Branch branch_code,@Pos pos_code,'__TARGET__' target_branch,@Tables tables,
   CASE WHEN @Writes>0 THEN 'applied' WHEN @Replay=1 THEN 'replayed' ELSE 'already_linked' END outcome,
   CONVERT(varchar(23),GETUTCDATE(),126)+'Z' verified_at,'ada-final-time-v1' time_policy,
   CONVERT(varchar(10),@SoldDate,120)+'T'+@SoldTime+'+07:00' submitted_sold_at,
   CONVERT(varchar(10),@NativeDate,120)+'T'+@NativeTime+'+07:00' native_sold_at,
   CONVERT(int,@Adjusted) time_adjusted,@NativeTable native_time_table;
 END TRY
 BEGIN CATCH
  IF CURSOR_STATUS('local','headers')>=0 CLOSE headers;
  IF CURSOR_STATUS('local','headers')>-3 DEALLOCATE headers;
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  DECLARE @Error nvarchar(2048);SET @Error=ERROR_MESSAGE();RAISERROR(@Error,16,1);
 END CATCH;
END;
