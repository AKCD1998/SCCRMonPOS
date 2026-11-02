-- Private, independently stoppable delivery outbox. Does not grant runtime roles,
-- touch SQL Server, or read/write the old SCCRM points ledger.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM ada_points.meta WHERE singleton AND schema_version=1
  AND scope='SCCRM-ADA-PRIMARY-POINTS-V1' AND marker='541be1f2-1b99-4d73-9d6a-5ef0a1ef2417')
 THEN RAISE EXCEPTION 'POINT_DELIVERY_STORE_NOT_OWNED';END IF;
 IF to_regclass('ada_points.delivery_meta') IS NULL THEN
  IF EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='ada_points'::regnamespace
   AND c.relname IN('delivery_targets','delivery_jobs','delivery_audit'))
  THEN RAISE EXCEPTION 'POINT_DELIVERY_SCHEMA_COLLISION';END IF;
 ELSIF (SELECT count(*) FROM ada_points.delivery_meta)<>1 OR NOT EXISTS(
  SELECT 1 FROM ada_points.delivery_meta WHERE singleton AND schema_version=1
   AND marker='fcd9c461-328b-4519-8a61-cea0cb46fe22')
 THEN RAISE EXCEPTION 'POINT_DELIVERY_SCHEMA_NOT_OWNED';END IF;
END $$;
CREATE TABLE IF NOT EXISTS ada_points.delivery_meta(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 schema_version integer NOT NULL CHECK(schema_version=1),
 marker uuid NOT NULL CHECK(marker='fcd9c461-328b-4519-8a61-cea0cb46fe22')
);
INSERT INTO ada_points.delivery_meta VALUES(true,1,'fcd9c461-328b-4519-8a61-cea0cb46fe22')
 ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS ada_points.delivery_targets(
 target_id varchar(64) PRIMARY KEY,
 database_identity text NOT NULL UNIQUE,
 branch_code varchar(3) NOT NULL UNIQUE CHECK(branch_code IN('000','001','003','004','005')),
 enabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS ada_points.delivery_jobs(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 target_id varchar(64) NOT NULL REFERENCES ada_points.delivery_targets(target_id),
 database_identity text NOT NULL,
 ada_code varchar(20) NOT NULL,
 generation bigint NOT NULL CHECK(generation>0),
 expected_intrinsic bigint NOT NULL,target_balance bigint NOT NULL,
 projection_version char(64) NOT NULL CHECK(projection_version~'^[a-f0-9]{64}$'),
 operation_id uuid NOT NULL UNIQUE,
 state text NOT NULL DEFAULT 'queued'
  CHECK(state IN('queued','leased','retry','succeeded','superseded','review')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
 lease_token uuid,lease_until timestamptz,next_attempt_at timestamptz DEFAULT clock_timestamp(),
 source_observed_at timestamptz NOT NULL,
 last_code varchar(128) NOT NULL DEFAULT 'QUEUED',
 queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 UNIQUE(target_id,ada_code,generation),
 CHECK((state='leased' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
  OR(state<>'leased' AND lease_token IS NULL AND lease_until IS NULL)),
 CHECK((state IN('succeeded','superseded','review'))=(completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ada_point_delivery_due ON ada_points.delivery_jobs(target_id,next_attempt_at,id)
 WHERE state IN('queued','retry');
CREATE INDEX IF NOT EXISTS ada_point_delivery_expired ON ada_points.delivery_jobs(target_id,lease_until,id)
 WHERE state='leased';
CREATE INDEX IF NOT EXISTS ada_point_delivery_owner ON ada_points.delivery_jobs(target_id,ada_code,generation);
CREATE TABLE IF NOT EXISTS ada_points.delivery_audit(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 job_id bigint NOT NULL REFERENCES ada_points.delivery_jobs(id),
 target_id varchar(64) NOT NULL,operation_id uuid NOT NULL,
 old_state text,new_state text NOT NULL,code varchar(128) NOT NULL,
 attempt_count integer NOT NULL,lease_token uuid,
 expected_intrinsic bigint NOT NULL,source_observed_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS ada_point_delivery_audit_job ON ada_points.delivery_audit(job_id,id);
CREATE OR REPLACE FUNCTION ada_points.delivery_keep_history() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,ada_points AS $$ BEGIN
 RAISE EXCEPTION 'POINT_DELIVERY_HISTORY_IS_APPEND_ONLY';
END $$;
CREATE OR REPLACE FUNCTION ada_points.delivery_job_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,ada_points AS $$ BEGIN
 IF ROW(NEW.id,NEW.target_id,NEW.database_identity,NEW.ada_code,NEW.generation,
  NEW.target_balance,NEW.projection_version,NEW.operation_id,NEW.queued_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.target_id,OLD.database_identity,OLD.ada_code,OLD.generation,
  OLD.target_balance,OLD.projection_version,OLD.operation_id,OLD.queued_at)
 THEN RAISE EXCEPTION 'POINT_DELIVERY_JOB_IDENTITY_IMMUTABLE';END IF;
 IF NEW.expected_intrinsic IS DISTINCT FROM OLD.expected_intrinsic AND NOT(
  OLD.state='retry' AND OLD.last_code='SOURCE_MOVED_RETRY' AND NEW.state='queued'
  AND NEW.source_observed_at>OLD.source_observed_at AND NEW.last_code='FRESH_SOURCE_REFRESHED')
 THEN RAISE EXCEPTION 'POINT_DELIVERY_EXPECTATION_REFRESH_REFUSED';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION ada_points.delivery_target_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,ada_points AS $$ BEGIN
 IF ROW(NEW.target_id,NEW.database_identity,NEW.branch_code,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.target_id,OLD.database_identity,OLD.branch_code,OLD.created_at)
 THEN RAISE EXCEPTION 'POINT_DELIVERY_TARGET_IDENTITY_IMMUTABLE';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION ada_points.delivery_record_change() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,ada_points AS $$ BEGIN
 IF TG_OP='INSERT' OR ROW(NEW.state,NEW.last_code,NEW.attempt_count,NEW.lease_token,
   NEW.expected_intrinsic,NEW.source_observed_at)
  IS DISTINCT FROM ROW(OLD.state,OLD.last_code,OLD.attempt_count,OLD.lease_token,
   OLD.expected_intrinsic,OLD.source_observed_at) THEN
  INSERT INTO ada_points.delivery_audit(job_id,target_id,operation_id,old_state,new_state,
   code,attempt_count,lease_token,expected_intrinsic,source_observed_at)
  VALUES(NEW.id,NEW.target_id,NEW.operation_id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.state END,
   NEW.state,NEW.last_code,NEW.attempt_count,NEW.lease_token,NEW.expected_intrinsic,NEW.source_observed_at);
 END IF;
 RETURN NEW;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='ada_points.delivery_jobs'::regclass AND tgname='delivery_job_guard') THEN
  CREATE TRIGGER delivery_job_guard BEFORE UPDATE ON ada_points.delivery_jobs FOR EACH ROW EXECUTE FUNCTION ada_points.delivery_job_guard();
  CREATE TRIGGER delivery_job_audit AFTER INSERT OR UPDATE ON ada_points.delivery_jobs FOR EACH ROW EXECUTE FUNCTION ada_points.delivery_record_change();
  CREATE TRIGGER delivery_jobs_preserve BEFORE DELETE ON ada_points.delivery_jobs FOR EACH ROW EXECUTE FUNCTION ada_points.delivery_keep_history();
  CREATE TRIGGER delivery_audit_preserve BEFORE UPDATE OR DELETE ON ada_points.delivery_audit FOR EACH ROW EXECUTE FUNCTION ada_points.delivery_keep_history();
  CREATE TRIGGER delivery_target_guard BEFORE UPDATE ON ada_points.delivery_targets FOR EACH ROW EXECUTE FUNCTION ada_points.delivery_target_guard();
  CREATE TRIGGER delivery_targets_preserve BEFORE DELETE ON ada_points.delivery_targets FOR EACH ROW EXECUTE FUNCTION ada_points.delivery_keep_history();
 END IF;
END $$;
DO $$ DECLARE t text;r text;BEGIN
 FOREACH t IN ARRAY ARRAY['delivery_meta','delivery_targets','delivery_jobs','delivery_audit'] LOOP
  EXECUTE format('ALTER TABLE ada_points.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON ada_points.%I FROM PUBLIC',t);
 END LOOP;
 REVOKE ALL ON FUNCTION ada_points.delivery_keep_history(),ada_points.delivery_job_guard(),
  ada_points.delivery_target_guard(),ada_points.delivery_record_change() FROM PUBLIC;
 REVOKE ALL ON SEQUENCE ada_points.delivery_jobs_id_seq,ada_points.delivery_audit_id_seq FROM PUBLIC;
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
   FOREACH t IN ARRAY ARRAY['delivery_meta','delivery_targets','delivery_jobs','delivery_audit'] LOOP
    EXECUTE format('REVOKE ALL ON ada_points.%I FROM %I',t,r);
   END LOOP;
   EXECUTE format('REVOKE ALL ON SEQUENCE ada_points.delivery_jobs_id_seq,ada_points.delivery_audit_id_seq FROM %I',r);
  END IF;
 END LOOP;
END $$;
