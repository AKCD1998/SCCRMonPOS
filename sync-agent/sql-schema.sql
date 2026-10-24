IF OBJECT_ID('dbo.SCCRM_MemberLink') IS NULL CREATE TABLE dbo.SCCRM_MemberLink(member_id uniqueidentifier PRIMARY KEY,ada_code varchar(20) NOT NULL UNIQUE,source_version int NOT NULL,payload_hash varchar(64) NOT NULL);
IF OBJECT_ID('dbo.SCCRM_BidiPointState') IS NULL CREATE TABLE dbo.SCCRM_BidiPointState(event_key nvarchar(200) PRIMARY KEY,ada_code varchar(20) NOT NULL,applied_amount bigint NOT NULL);
IF OBJECT_ID('dbo.SCCRM_BidiPointReceipt') IS NULL CREATE TABLE dbo.SCCRM_BidiPointReceipt(receipt_id uniqueidentifier PRIMARY KEY,event_key nvarchar(200) NOT NULL,ada_code varchar(20) NOT NULL,target_amount bigint NOT NULL,applied_delta bigint NOT NULL);
IF OBJECT_ID('dbo.SCCRM_ObservedNative') IS NULL CREATE TABLE dbo.SCCRM_ObservedNative(raw_key varchar(150) PRIMARY KEY,event_key nvarchar(200) NOT NULL,member_id uniqueidentifier NOT NULL,ada_code varchar(20) NOT NULL,amount bigint NOT NULL,payload_hash varchar(64) NOT NULL,baseline bit NOT NULL DEFAULT 0);
GO
CREATE PROCEDURE dbo.SCCRM_ObservePoint @RawKey varchar(150),@EventKey nvarchar(200),@MemberId uniqueidentifier,@Code varchar(20),@Amount bigint,@Hash varchar(64),@Baseline bit
AS
BEGIN
 SET NOCOUNT ON; SET XACT_ABORT ON;
 BEGIN TRY
  BEGIN TRANSACTION;
  DECLARE @Prior varchar(64),@OldCode varchar(20);
  SELECT @Prior=payload_hash,@OldCode=ada_code FROM dbo.SCCRM_ObservedNative WITH(UPDLOCK,HOLDLOCK) WHERE raw_key=@RawKey;
  IF @Prior IS NOT NULL BEGIN IF @Prior<>@Hash OR @OldCode<>@Code RAISERROR('NATIVE_EVENT_MUTATION_REVIEW',16,1);COMMIT;SELECT 'unchanged' outcome;RETURN;END;
  INSERT dbo.SCCRM_ObservedNative(raw_key,event_key,member_id,ada_code,amount,payload_hash,baseline) VALUES(@RawKey,@EventKey,@MemberId,@Code,@Amount,@Hash,@Baseline);
  IF @Baseline=0 BEGIN
   IF EXISTS(SELECT 1 FROM dbo.SCCRM_BidiPointState WITH(UPDLOCK,HOLDLOCK) WHERE event_key=@EventKey AND ada_code<>@Code) RAISERROR('POINT_MEMBER_CHANGE_REFUSED',16,1);
   IF EXISTS(SELECT 1 FROM dbo.SCCRM_BidiPointState WHERE event_key=@EventKey) UPDATE dbo.SCCRM_BidiPointState SET applied_amount=applied_amount+@Amount WHERE event_key=@EventKey;
   ELSE INSERT dbo.SCCRM_BidiPointState(event_key,ada_code,applied_amount) VALUES(@EventKey,@Code,@Amount);
  END;
  COMMIT;SELECT 'observed' outcome;
 END TRY
 BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK;
  DECLARE @Reason nvarchar(4000);SET @Reason=ERROR_MESSAGE();RAISERROR(@Reason,16,1);
 END CATCH;
END;
