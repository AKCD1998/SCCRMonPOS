-- Apply only to an independently verified, owned HQ or branch COPY first.
-- The existing module backup/install workflow supplies the database identity.
SET XACT_ABORT ON;
SET LOCK_TIMEOUT 1000;
IF NOT EXISTS(SELECT 1 FROM sys.extended_properties WHERE class=1
 AND major_id=OBJECT_ID('dbo.SCCRM_MemberCodeScope') AND name='SCCRM_MemberCodesMarker'
 AND CONVERT(nvarchar(36),value)='64fa3170-80ae-45ee-b9f3-7478b2a46e34') OR NOT EXISTS(
 SELECT 1 FROM sys.extended_properties WHERE class=1 AND major_id=OBJECT_ID('dbo.SCCRM_MemberCodeAssignments')
 AND name='SCCRM_MemberCodesMarker' AND CONVERT(nvarchar(36),value)='64fa3170-80ae-45ee-b9f3-7478b2a46e34')
 BEGIN RAISERROR('MEMBER_CODES_REGISTRATION_SCHEMA_REFUSED',16,1);RETURN;END;
BEGIN TRANSACTION;
IF COL_LENGTH('dbo.SCCRM_MemberCodeAssignments','registration_confirmation') IS NULL
 ALTER TABLE dbo.SCCRM_MemberCodeAssignments ADD registration_confirmation uniqueidentifier NULL;
IF NOT EXISTS(SELECT 1 FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID('dbo.SCCRM_MemberCodeAssignments')
 AND name='SCCRM_RegistrationAssignmentKind')
BEGIN
 ALTER TABLE dbo.SCCRM_MemberCodeAssignments WITH CHECK ADD CONSTRAINT SCCRM_RegistrationAssignmentKind
  CHECK(assignment_kind IN('hq_create','hq_create_distinct','approved_existing'));
 DECLARE @Constraint sysname,@AlterConstraint nvarchar(1000);
 DECLARE OwnedChecks CURSOR LOCAL FAST_FORWARD FOR
  SELECT name FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID('dbo.SCCRM_MemberCodeAssignments')
   AND name<>'SCCRM_RegistrationAssignmentKind'
   AND parent_column_id=COLUMNPROPERTY(OBJECT_ID('dbo.SCCRM_MemberCodeAssignments'),'assignment_kind','ColumnId');
 OPEN OwnedChecks;FETCH NEXT FROM OwnedChecks INTO @Constraint;
 WHILE @@FETCH_STATUS=0
 BEGIN
  SET @AlterConstraint='ALTER TABLE dbo.SCCRM_MemberCodeAssignments DROP CONSTRAINT '+QUOTENAME(@Constraint);
  EXEC(@AlterConstraint);
  FETCH NEXT FROM OwnedChecks INTO @Constraint;
 END;
 CLOSE OwnedChecks;DEALLOCATE OwnedChecks;
END;
COMMIT;
