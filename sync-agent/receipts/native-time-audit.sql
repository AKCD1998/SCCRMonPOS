-- Owned append-only evidence; never a customer, sale, or point table.
CREATE TABLE dbo.SCCRM_ReceiptTimeAudit(
 operation_id uniqueidentifier PRIMARY KEY,payload_hash char(64) NOT NULL,
 submitted_date datetime NOT NULL,submitted_time varchar(8) NOT NULL,
 native_date datetime NOT NULL,native_time varchar(8) NOT NULL,native_time_table varchar(20) NOT NULL,
 time_adjusted bit NOT NULL,observations xml NOT NULL,recorded_at datetime NOT NULL
);
