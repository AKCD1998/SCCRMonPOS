CREATE PROCEDURE dbo.SCCRM_ReadReceiptSnapshot
 @Branch char(3),@Pos char(3),@Doc varchar(20),@AdaCode varchar(20),@ExpectedName nvarchar(255),@ExpectedPhone varchar(30)
WITH EXECUTE AS OWNER
AS
BEGIN
 SET NOCOUNT ON;SET DEADLOCK_PRIORITY LOW;SET LOCK_TIMEOUT 500;
 IF DB_NAME()<>'__DATABASE__' OR NOT EXISTS(SELECT 1 FROM dbo.SCCRM_ReceiptSyncMeta WHERE singleton=1
  AND marker='ab01553b-576c-465e-af30-87daa20e2d33' AND target_branch='__TARGET__')
 BEGIN RAISERROR('RECON_TARGET_REFUSED',16,1);RETURN;END;
 IF @Branch NOT IN('001','003','004','005') OR @Pos NOT IN('001','002') OR ('__TARGET__'<>'000' AND @Branch<>'__TARGET__')
  OR @Doc IS NULL OR @Doc NOT LIKE 'S[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9]%'
  OR @Doc LIKE '%[^S0-9-]%' OR @AdaCode IS NULL OR @AdaCode NOT LIKE 'AR[0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]'
 BEGIN RAISERROR('RECON_PACKET_REFUSED',16,1);RETURN;END;
 DECLARE @Header sysname,@Detail sysname,@Payment sysname,@Sql nvarchar(max),@Found int;
 SET @Header='TPSTSalHD';SET @Found=0;
 IF '__TARGET__'<>'000' AND OBJECT_ID('dbo.TSHD'+@Pos) IS NOT NULL
 BEGIN
  SET @Sql=N'SELECT @Found=COUNT(*) FROM dbo.'+QUOTENAME('TSHD'+@Pos)+N' WHERE FTBchCode=@Branch AND FTPosCode=@Pos AND FTShdDocNo=@Doc;';
  EXEC sys.sp_executesql @Sql,N'@Branch char(3),@Pos char(3),@Doc varchar(20),@Found int OUTPUT',@Branch,@Pos,@Doc,@Found OUTPUT;
  IF @Found>0 SET @Header='TSHD'+@Pos;
 END;
 SET @Detail=CASE WHEN @Header='TPSTSalHD' THEN 'TPSTSalDT' ELSE 'TSDT'+@Pos END;
 SET @Payment=CASE WHEN @Header='TPSTSalHD' THEN 'TPSTSalRC' ELSE 'TSRC'+@Pos END;
 IF OBJECT_ID('dbo.'+@Header) IS NULL OR OBJECT_ID('dbo.'+@Detail) IS NULL OR OBJECT_ID('dbo.'+@Payment) IS NULL
 BEGIN RAISERROR('RECON_SOURCE_NOT_ARRIVED',16,1);RETURN;END;
 SET @Sql=N'
 SELECT @Header AS sourceTable,FTBchCode branchCode,FTPosCode posCode,FTShdDocNo receiptNo,LTRIM(RTRIM(ISNULL(FTCstCode,''''))) adaCode,
  FTShdDocType docType,FTShdStaPaid paidStatus,FTShdStaDoc documentStatus,FCShdGrand totalAmount,FCShdDis receiptDiscount,ISNULL(FCShdRnd,0) rounding,
  CONVERT(char(10),FDShdDocDate,120) docDate,LTRIM(RTRIM(FTShdDocTime)) docTime
 FROM dbo.'+QUOTENAME(@Header)+N' WHERE FTBchCode=@Branch AND FTPosCode=@Pos AND FTShdDocNo=@Doc;
 SELECT FNSdtSeqNo seq,LTRIM(RTRIM(FTPdtCode)) productCode,LTRIM(RTRIM(FTPdtName)) productName,LTRIM(RTRIM(FTSdtBarCode)) barcode,
  LTRIM(RTRIM(FTPunCode)) unitCode,LTRIM(RTRIM(FTSdtUnitName)) unitName,FCSdtQty qty,FCSdtSetPrice unitPrice,FCSdtNet lineTotal,
  ISNULL(FCSdtDis,0) lineDiscount,NULLIF(LTRIM(RTRIM(FTPmhCode)),'''') promotionCode
 FROM dbo.'+QUOTENAME(@Detail)+N' WHERE FTBchCode=@Branch AND FTShdDocNo=@Doc ORDER BY FNSdtSeqNo;
 SELECT FNSrcSeqNo seq,LTRIM(RTRIM(FTRcvCode)) code,FCSrcAmt amount,FCSrcNet net,FCSrcChg change
 FROM dbo.'+QUOTENAME(@Payment)+N' WHERE FTShdDocNo=@Doc ORDER BY FNSrcSeqNo;';
 EXEC sys.sp_executesql @Sql,N'@Branch char(3),@Pos char(3),@Doc varchar(20),@Header sysname',@Branch,@Pos,@Doc,@Header;
 SELECT branch_code branchCode,pos_code posCode,doc_no receiptNo,ada_code adaCode FROM dbo.SCCRM_ReceiptSyncJournal WHERE branch_code=@Branch AND doc_no=@Doc;
 SELECT CONVERT(bit,CASE WHEN EXISTS(SELECT 1 FROM dbo.TCNMCst WHERE FTCstCode=@AdaCode
  AND LTRIM(RTRIM(CONVERT(nvarchar(255),FTCstName))) COLLATE Latin1_General_BIN2=LTRIM(RTRIM(@ExpectedName)) COLLATE Latin1_General_BIN2
  AND(@ExpectedPhone IS NULL OR ISNULL(LTRIM(RTRIM(FTCstTel)),'')=@ExpectedPhone)) THEN 1 ELSE 0 END) memberMatches,
 CONVERT(bit,CASE WHEN EXISTS(SELECT 1 FROM dbo.TCNMCst WHERE FTCstCode='0'
  AND LTRIM(RTRIM(CONVERT(nvarchar(255),FTCstName))) COLLATE Latin1_General_BIN2=N'ลูกค้าทั่วไป' COLLATE Latin1_General_BIN2) THEN 1 ELSE 0 END) walkInVerified;
END;
