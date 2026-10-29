-- Additive, private queue only. Provision/review with an administrator; this file
-- neither connects to Ada nor grants a runtime role. No customer/ledger DML.
DO $$ BEGIN
 IF to_regnamespace('sccrm_fanout') IS NOT NULL THEN
  IF to_regclass('sccrm_fanout.meta') IS NULL THEN RAISE EXCEPTION 'FANOUT_SCHEMA_NOT_OWNED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM sccrm_fanout.meta WHERE singleton=true AND marker='936590f2-023e-46a0-b4c8-e64c1fe8cf7d'::uuid AND scope='SCCRM-HQ-BRANCH-FANOUT-V1' AND schema_version=1)
     OR (SELECT count(*) FROM sccrm_fanout.meta)<>1 THEN RAISE EXCEPTION 'FANOUT_SCHEMA_NOT_OWNED'; END IF;
 END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS sccrm_fanout;
REVOKE ALL ON SCHEMA sccrm_fanout FROM PUBLIC;
CREATE TABLE IF NOT EXISTS sccrm_fanout.meta(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), marker uuid NOT NULL,
 scope text NOT NULL, schema_version integer NOT NULL
);
INSERT INTO sccrm_fanout.meta(singleton,marker,scope,schema_version)
VALUES(true,'936590f2-023e-46a0-b4c8-e64c1fe8cf7d','SCCRM-HQ-BRANCH-FANOUT-V1',1)
ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS sccrm_fanout.targets(
 target_id text PRIMARY KEY CHECK(length(target_id) BETWEEN 1 AND 100),
 database_identity text NOT NULL UNIQUE CHECK(length(database_identity) BETWEEN 1 AND 512),
 branch_code text NOT NULL CHECK(branch_code ~ '^[0-9]{3}$'),
 enabled boolean NOT NULL DEFAULT false,
 lease_token uuid, lease_owner uuid, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((lease_token IS NULL AND lease_owner IS NULL AND lease_until IS NULL)
    OR (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS sccrm_fanout.sources(
 member_id uuid PRIMARY KEY, hq_code varchar(20) NOT NULL UNIQUE,
 profile jsonb NOT NULL CHECK(jsonb_typeof(profile)='object'
  AND profile ?& ARRAY['name','phone','email'] AND profile-ARRAY['name','phone','email']='{}'::jsonb
  AND jsonb_typeof(profile->'name')='string' AND length(profile->>'name') BETWEEN 1 AND 200
  AND jsonb_typeof(profile->'phone')='string' AND (profile->>'phone') ~ '^0[0-9]{9}$'
  AND jsonb_typeof(profile->'email')='string' AND length(profile->>'email')<=100),
 profile_hash char(64) NOT NULL CHECK(profile_hash ~ '^[a-f0-9]{64}$'), hq_created_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'confirmed' CHECK(state IN('confirmed','review')),
 last_code varchar(80) CHECK(last_code ~ '^[A-Z][A-Z0-9_]{2,79}$'), observed_conflict_hash char(64),
 received_at timestamptz NOT NULL DEFAULT now(), UNIQUE(member_id,hq_code,profile_hash),
 CHECK(hq_code='SC-'||upper(left(replace(member_id::text,'-',''),16)))
);
CREATE INDEX IF NOT EXISTS fanout_source_cursor ON sccrm_fanout.sources(hq_created_at,member_id);
CREATE TABLE IF NOT EXISTS sccrm_fanout.source_checkpoint(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), created_at timestamptz,
 member_id uuid REFERENCES sccrm_fanout.sources(member_id), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((created_at IS NULL AND member_id IS NULL) OR(created_at IS NOT NULL AND member_id IS NOT NULL))
);
INSERT INTO sccrm_fanout.source_checkpoint(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS sccrm_fanout.jobs(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 target_id text NOT NULL REFERENCES sccrm_fanout.targets(target_id), member_id uuid NOT NULL REFERENCES sccrm_fanout.sources(member_id),
 hq_code varchar(20) NOT NULL,
 profile jsonb NOT NULL CHECK(jsonb_typeof(profile)='object'
  AND profile ?& ARRAY['name','phone','email'] AND profile-ARRAY['name','phone','email']='{}'::jsonb
  AND jsonb_typeof(profile->'name')='string' AND length(profile->>'name') BETWEEN 1 AND 200
  AND jsonb_typeof(profile->'phone')='string' AND (profile->>'phone') ~ '^0[0-9]{9}$'
  AND jsonb_typeof(profile->'email')='string' AND length(profile->>'email')<=100),
 profile_hash char(64) NOT NULL CHECK(profile_hash ~ '^[a-f0-9]{64}$'),
 idempotency_key char(64) NOT NULL UNIQUE CHECK(idempotency_key ~ '^[a-f0-9]{64}$'),
 hq_created_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','running','retry','review','succeeded')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid, lease_owner uuid, lease_until timestamptz,
 last_code varchar(80) CHECK(last_code ~ '^[A-Z][A-Z0-9_]{2,79}$'),
 observed_conflict_hash char(64), queued_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(target_id,member_id),
 FOREIGN KEY(member_id,hq_code,profile_hash) REFERENCES sccrm_fanout.sources(member_id,hq_code,profile_hash),
 CHECK(hq_code='SC-'||upper(left(replace(member_id::text,'-',''),16))),
 CHECK((state='running' AND lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
    OR (state<>'running' AND lease_token IS NULL AND lease_owner IS NULL AND lease_until IS NULL))
);
CREATE INDEX IF NOT EXISTS fanout_due_jobs ON sccrm_fanout.jobs(target_id,next_attempt_at,id)
 WHERE state IN('pending','retry','running');
CREATE TABLE IF NOT EXISTS sccrm_fanout.mappings(
 target_id text NOT NULL REFERENCES sccrm_fanout.targets(target_id), member_id uuid NOT NULL,
 ada_code varchar(20) NOT NULL, hq_code varchar(20) NOT NULL,
 database_identity text NOT NULL, profile_hash char(64) NOT NULL CHECK(profile_hash ~ '^[a-f0-9]{64}$'),
 native_receipt jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(target_id,member_id), UNIQUE(target_id,ada_code),
 FOREIGN KEY(member_id,hq_code,profile_hash) REFERENCES sccrm_fanout.sources(member_id,hq_code,profile_hash),
 CHECK(hq_code='SC-'||upper(left(replace(member_id::text,'-',''),16))), CHECK(ada_code=hq_code)
);
CREATE TABLE IF NOT EXISTS sccrm_fanout.events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 job_id bigint NOT NULL REFERENCES sccrm_fanout.jobs(id), attempt integer NOT NULL,
 state text NOT NULL CHECK(state IN('pending','running','retry','review','succeeded')),
 code varchar(80) NOT NULL CHECK(code ~ '^[A-Z][A-Z0-9_]{2,79}$'),
 occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fanout_events_job ON sccrm_fanout.events(job_id,id);
CREATE OR REPLACE FUNCTION sccrm_fanout.guard_target_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,sccrm_fanout AS $$ BEGIN
 IF NEW.target_id IS DISTINCT FROM OLD.target_id OR NEW.database_identity IS DISTINCT FROM OLD.database_identity
 OR NEW.branch_code IS DISTINCT FROM OLD.branch_code THEN RAISE EXCEPTION 'FANOUT_TARGET_IDENTITY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_target_identity ON sccrm_fanout.targets;
CREATE TRIGGER guard_target_identity BEFORE UPDATE ON sccrm_fanout.targets
 FOR EACH ROW EXECUTE FUNCTION sccrm_fanout.guard_target_identity();
CREATE OR REPLACE FUNCTION sccrm_fanout.guard_mapping_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,sccrm_fanout AS $$ BEGIN
 RAISE EXCEPTION 'FANOUT_MAPPING_IMMUTABLE';
END $$;
DROP TRIGGER IF EXISTS guard_mapping_identity ON sccrm_fanout.mappings;
CREATE TRIGGER guard_mapping_identity BEFORE UPDATE OR DELETE ON sccrm_fanout.mappings
 FOR EACH ROW EXECUTE FUNCTION sccrm_fanout.guard_mapping_identity();
REVOKE ALL ON ALL TABLES IN SCHEMA sccrm_fanout FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA sccrm_fanout FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sccrm_fanout FROM PUBLIC;
ALTER TABLE sccrm_fanout.meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_fanout.targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_fanout.sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_fanout.source_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_fanout.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_fanout.mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_fanout.events ENABLE ROW LEVEL SECURITY;
-- Provisioner must add role-specific RLS/grants. Runtime needs SELECT on all;
-- INSERT on sources/jobs/mappings/events; UPDATE only state/conflict columns of
-- sources, cursor columns of source_checkpoint, lease columns of targets and
-- state/attempt/lease/retry/conflict/completion columns of jobs; no DELETE.
