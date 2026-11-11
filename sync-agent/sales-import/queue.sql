-- Template owned queue. Replaced database/marker/schema identifiers are fixed by provisioner.
CREATE TABLE dbo.SCCRM_SalesMeta(singleton int PRIMARY KEY CHECK(singleton=1),marker uniqueidentifier NOT NULL,schema_hash char(64) NOT NULL,scope varchar(80) NOT NULL);
CREATE TABLE dbo.SCCRM_SalesSources(branch_code char(3) PRIMARY KEY,enabled bit NOT NULL DEFAULT 0,last_scan_at datetime);
INSERT dbo.SCCRM_SalesSources(branch_code,enabled) VALUES('001',0),('003',0),('004',0),('005',0);
CREATE TABLE dbo.SCCRM_SalesJobs(id uniqueidentifier PRIMARY KEY,branch_code char(3) NOT NULL,doc_no varchar(20) NOT NULL,
 state varchar(15) NOT NULL CHECK(state IN('pending','running','retry','review','succeeded')),packet nvarchar(max),payload_hash char(64),
 attempts int NOT NULL DEFAULT 0,next_attempt_at datetime NOT NULL DEFAULT GETUTCDATE(),lease_token uniqueidentifier,lease_until datetime,last_code varchar(80),
 created_at datetime NOT NULL DEFAULT GETUTCDATE(),updated_at datetime NOT NULL DEFAULT GETUTCDATE(),completed_at datetime,
 UNIQUE(branch_code,doc_no),FOREIGN KEY(branch_code) REFERENCES dbo.SCCRM_SalesSources(branch_code));
CREATE INDEX SCCRM_Sales_Due ON dbo.SCCRM_SalesJobs(branch_code,state,next_attempt_at);
CREATE TABLE dbo.SCCRM_SalesJournal(branch_code char(3) NOT NULL,doc_no varchar(20) NOT NULL,job_id uniqueidentifier NOT NULL,payload_hash char(64) NOT NULL,
 outcome varchar(40) NOT NULL,inserted_rows int NOT NULL,committed_at datetime NOT NULL,PRIMARY KEY(branch_code,doc_no),UNIQUE(job_id));
CREATE TABLE dbo.SCCRM_SalesEvents(id bigint IDENTITY PRIMARY KEY,job_id uniqueidentifier NOT NULL,state varchar(15) NOT NULL,code varchar(80) NOT NULL,occurred_at datetime NOT NULL);
-- BATCH
CREATE PROCEDURE dbo.SCCRM_SalesQueue @Action varchar(20),@Branch char(3)=NULL,@Doc varchar(20)=NULL,@Id uniqueidentifier=NULL,@Lease uniqueidentifier=NULL,
 @Packet nvarchar(max)=NULL,@Hash char(64)=NULL,@Code varchar(80)=NULL,@Review bit=0 WITH EXECUTE AS OWNER AS
BEGIN
 SET NOCOUNT ON;SET XACT_ABORT ON;SET DEADLOCK_PRIORITY LOW;SET LOCK_TIMEOUT 750;
 IF DB_NAME()<>'__DATABASE__' OR NOT EXISTS(SELECT 1 FROM dbo.SCCRM_SalesMeta WHERE marker='__MARKER__' AND schema_hash='__SCHEMA__')
 BEGIN RAISERROR('SALES_TARGET_REFUSED',16,1);RETURN;END;
 IF @Action='Status' BEGIN
  SELECT s.branch_code,s.enabled,s.last_scan_at,j.state,COUNT(j.id) jobs,MAX(j.completed_at) last_completed_at,MIN(CASE WHEN j.state IN('pending','retry') THEN j.created_at ELSE NULL END) oldest_waiting_at
  FROM dbo.SCCRM_SalesSources s LEFT JOIN dbo.SCCRM_SalesJobs j ON j.branch_code=s.branch_code GROUP BY s.branch_code,s.enabled,s.last_scan_at,j.state;RETURN;END;
 IF @Branch NOT IN('001','003','004','005') OR @Branch IS NULL BEGIN RAISERROR('SALES_BRANCH_REFUSED',16,1);RETURN;END;
 IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_SalesSources WHERE branch_code=@Branch AND enabled=1) BEGIN SELECT 1 paused;RETURN;END;
 BEGIN TRY
 IF @Action='MarkScan' BEGIN UPDATE dbo.SCCRM_SalesSources SET last_scan_at=GETUTCDATE() WHERE branch_code=@Branch;RETURN;END;
 IF @Action='Enqueue' BEGIN
  IF @Doc IS NULL OR LEN(@Doc)<>19 OR LEFT(@Doc,1) NOT IN('S','R') OR SUBSTRING(@Doc,6,3)<>@Branch OR SUBSTRING(@Doc,9,3) NOT IN('001','002') OR SUBSTRING(@Doc,12,1)<>'-' OR @Doc LIKE '%[^A-Z0-9-]%'
   RAISERROR('SALES_DOCUMENT_REFUSED',16,1);
  BEGIN TRANSACTION;
  IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_SalesJobs WITH(UPDLOCK,HOLDLOCK) WHERE branch_code=@Branch AND doc_no=@Doc)
   INSERT dbo.SCCRM_SalesJobs(id,branch_code,doc_no,state) VALUES(NEWID(),@Branch,@Doc,'pending');
  COMMIT TRANSACTION;SELECT id,state FROM dbo.SCCRM_SalesJobs WHERE branch_code=@Branch AND doc_no=@Doc;RETURN;
 END;
 IF @Action='Lease' BEGIN
  SET @Id=NULL;
  BEGIN TRANSACTION;
  SELECT TOP(1) @Id=id FROM dbo.SCCRM_SalesJobs WITH(UPDLOCK,READPAST,ROWLOCK) WHERE branch_code=@Branch AND
   ((state IN('pending','retry') AND next_attempt_at<=GETUTCDATE()) OR(state='running' AND lease_until<GETUTCDATE())) ORDER BY next_attempt_at,created_at,id;
  IF @Id IS NOT NULL BEGIN
   SET @Lease=NEWID();UPDATE dbo.SCCRM_SalesJobs SET state='running',lease_token=@Lease,lease_until=DATEADD(second,60,GETUTCDATE()),attempts=attempts+1,updated_at=GETUTCDATE() WHERE id=@Id;
   INSERT dbo.SCCRM_SalesEvents(job_id,state,code,occurred_at) VALUES(@Id,'running','SALES_SENDING',GETUTCDATE());
  END;
  COMMIT TRANSACTION;SELECT id,branch_code,doc_no,packet,payload_hash,lease_token FROM dbo.SCCRM_SalesJobs WHERE id=@Id;RETURN;
 END;
 IF @Action='Prepare' BEGIN
  IF @Packet IS NULL OR LEN(@Packet)>1048576 OR @Hash IS NULL OR LEN(@Hash)<>64 OR @Hash LIKE '%[^a-f0-9]%' RAISERROR('SALES_PACKET_REFUSED',16,1);
  UPDATE dbo.SCCRM_SalesJobs SET packet=@Packet,payload_hash=@Hash,updated_at=GETUTCDATE() WHERE id=@Id AND branch_code=@Branch AND state='running' AND lease_token=@Lease AND lease_until>GETUTCDATE() AND packet IS NULL;
  IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_SalesJobs WHERE id=@Id AND branch_code=@Branch AND lease_token=@Lease AND lease_until>GETUTCDATE() AND payload_hash=@Hash AND packet=@Packet) RAISERROR('SALES_PACKET_IMMUTABLE',16,1);
  RETURN;
 END;
 IF @Action='Fail' BEGIN
  IF @Code IS NULL OR @Code NOT LIKE 'SALES[_]%' OR @Code LIKE '%[^A-Z_0-9]%' RAISERROR('SALES_FAILURE_CODE_REFUSED',16,1);
  BEGIN TRANSACTION;
  UPDATE dbo.SCCRM_SalesJobs SET state=CASE WHEN @Review=1 THEN 'review' ELSE 'retry' END,last_code=@Code,updated_at=GETUTCDATE(),
   next_attempt_at=DATEADD(second,CASE WHEN attempts>30 THEN 300 ELSE attempts*10 END,GETUTCDATE()),lease_token=NULL,lease_until=NULL
   WHERE id=@Id AND branch_code=@Branch AND state='running' AND lease_token=@Lease;
  IF @@ROWCOUNT=1 INSERT dbo.SCCRM_SalesEvents(job_id,state,code,occurred_at)VALUES(@Id,CASE WHEN @Review=1 THEN 'review' ELSE 'retry' END,@Code,GETUTCDATE());
  COMMIT TRANSACTION;RETURN;
 END;
 RAISERROR('SALES_ACTION_REFUSED',16,1);
 END TRY BEGIN CATCH IF XACT_STATE()<>0 ROLLBACK TRANSACTION;DECLARE @error nvarchar(2048);SET @error=ERROR_MESSAGE();RAISERROR(@error,16,1);END CATCH;
END;
