-- Additive authority and publication state; explicit operator provisioning only.
-- No Ada DML, no old fanout envelope/mapping changes, no public.users changes.
-- Preserve existing sccrm_fanout SCOPE and idempotency hashes unchanged.
-- A separately scoped authority importer must verify the exact owned HQ native
-- journal before INSERT. An AR-looking string, phone match, or this schema's
-- CHECK constraints are not proof of authority. Do NOT grant ordinary fanout
-- runtime/receiver roles INSERT here or expose this private schema in the API.
DO $$ BEGIN
 IF to_regnamespace('sccrm_member_codes') IS NOT NULL THEN
  IF to_regclass('sccrm_member_codes.meta') IS NULL THEN RAISE EXCEPTION 'CODE_AUTHORITY_SCHEMA_NOT_OWNED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM sccrm_member_codes.meta WHERE singleton=true
   AND marker='cffb05d6-116a-458d-98ba-52473745c116'::uuid
   AND scope='SCCRM-HQ-MEMBER-CODE-AUTHORITY-V1' AND schema_version=1)
   OR (SELECT count(*) FROM sccrm_member_codes.meta)<>1 THEN RAISE EXCEPTION 'CODE_AUTHORITY_SCHEMA_NOT_OWNED'; END IF;
 END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS sccrm_member_codes;
REVOKE ALL ON SCHEMA sccrm_member_codes FROM PUBLIC;
CREATE TABLE IF NOT EXISTS sccrm_member_codes.meta(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), marker uuid NOT NULL,
 scope text NOT NULL, schema_version integer NOT NULL,
 expected_hq_identity varchar(160) NOT NULL DEFAULT 'hq000/SERVER.SQLEXPRESS/AdaAcc/64fa3170-80ae-45ee-b9f3-7478b2a46e34'
 CHECK(length(expected_hq_identity)>0 AND btrim(expected_hq_identity)=expected_hq_identity)
);
INSERT INTO sccrm_member_codes.meta(singleton,marker,scope,schema_version)
VALUES(true,'cffb05d6-116a-458d-98ba-52473745c116','SCCRM-HQ-MEMBER-CODE-AUTHORITY-V1',1)
ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS sccrm_member_codes.assignments(
 assignment_id uuid PRIMARY KEY, member_id uuid NOT NULL UNIQUE,
 ada_code varchar(20) NOT NULL UNIQUE CHECK(ada_code ~ '^AR(000|001|003|004|005)-[0-9]{6}$' AND right(ada_code,6)<>'000000'),
 hq_identity varchar(160) NOT NULL CHECK(length(hq_identity)>0 AND btrim(hq_identity)=hq_identity),
 profile_hash char(64) NOT NULL CHECK(profile_hash ~ '^[a-f0-9]{64}$'),
 profile jsonb NOT NULL CHECK(jsonb_typeof(profile)='object'
  AND profile ?& ARRAY['name','phone','email'] AND profile-ARRAY['name','phone','email']='{}'::jsonb
  AND jsonb_typeof(profile->'name')='string' AND length(profile->>'name') BETWEEN 1 AND 200
  AND jsonb_typeof(profile->'phone')='string' AND (profile->>'phone') ~ '^0[0-9]{9}$'
  AND jsonb_typeof(profile->'email')='string' AND length(profile->>'email')<=100),
 assigned_at timestamptz NOT NULL, version integer NOT NULL CHECK(version=1),
 kind text NOT NULL CHECK(kind IN('hq_create','approved_existing')),
 deliver_to_branches boolean NOT NULL DEFAULT true,
 assignment_hash char(64) NOT NULL CHECK(assignment_hash ~ '^[a-f0-9]{64}$'),
 authority_reference text NOT NULL CHECK(length(authority_reference) BETWEEN 1 AND 500),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 CHECK(kind<>'hq_create' OR ada_code ~ '^AR000-[0-9]{6}$'),
 UNIQUE(assignment_id,member_id,ada_code), UNIQUE(assignment_id,member_id),
 UNIQUE(assignment_id,member_id,ada_code,profile_hash,assignment_hash),
 UNIQUE(assignment_id,member_id,ada_code,profile_hash,assignment_hash,deliver_to_branches)
);
-- Publish only an authority-backed canonical code. The original public member
-- row, user UUID, historical links, bill owner, and fanout SC mappings stay as
-- they were. API/search integration may resolve this row plus aliases; no
-- public API/GRANT/trigger on existing member tables is introduced here.
CREATE TABLE IF NOT EXISTS sccrm_member_codes.canonical_codes(
 member_id uuid PRIMARY KEY, assignment_id uuid NOT NULL UNIQUE,
 canonical_code varchar(20) NOT NULL UNIQUE,
 previous_native_code varchar(20),
 publication_reference text NOT NULL CHECK(length(publication_reference) BETWEEN 1 AND 500),
 registered_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(assignment_id,member_id,canonical_code)
  REFERENCES sccrm_member_codes.assignments(assignment_id,member_id,ada_code),
 CHECK(previous_native_code IS NULL OR previous_native_code='SC-'||upper(left(replace(member_id::text,'-',''),16))),
 UNIQUE(assignment_id,member_id)
);
CREATE TABLE IF NOT EXISTS sccrm_member_codes.aliases(
 code varchar(50) PRIMARY KEY, member_id uuid NOT NULL, assignment_id uuid NOT NULL,
 reason text NOT NULL CHECK(reason IN('LEGACY_OWNED_ADA_CODE','LEGACY_SCCRM_MEMBER_CODE')),
 approval_reference text NOT NULL CHECK(length(approval_reference) BETWEEN 1 AND 500),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(assignment_id,member_id)
  REFERENCES sccrm_member_codes.canonical_codes(assignment_id,member_id),
 CHECK((reason='LEGACY_OWNED_ADA_CODE' AND code='SC-'||upper(left(replace(member_id::text,'-',''),16)))
  OR(reason='LEGACY_SCCRM_MEMBER_CODE' AND code='SCM-'||upper(left(replace(member_id::text,'-',''),8))))
);
CREATE INDEX IF NOT EXISTS member_code_alias_member ON sccrm_member_codes.aliases(member_id);
-- Append-only cohort migration events are separate from the ordinary create
-- queue. Actual native migration/reference checks are owned by the migration
-- coordinator. Event presence alone must never authorize customer DML.
CREATE TABLE IF NOT EXISTS sccrm_member_codes.migration_events(
 event_id uuid PRIMARY KEY, migration_id uuid NOT NULL,
 assignment_id uuid NOT NULL, member_id uuid NOT NULL,
 phase text NOT NULL CHECK(phase IN('prepared','hq-created','branch-authorized','branch-created','published','held','rollback-requested')),
 target_identity varchar(160),
 review_code varchar(80) CHECK(review_code ~ '^[A-Z][A-Z0-9_]{2,79}$'),
 authority_reference text NOT NULL CHECK(length(authority_reference) BETWEEN 1 AND 500),
 occurred_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(assignment_id,member_id)
  REFERENCES sccrm_member_codes.assignments(assignment_id,member_id)
);
CREATE INDEX IF NOT EXISTS member_code_migration_member ON sccrm_member_codes.migration_events(member_id,occurred_at,event_id);
CREATE TABLE IF NOT EXISTS sccrm_member_codes.publication_events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, assignment_id uuid NOT NULL,
 member_id uuid NOT NULL, code varchar(20) NOT NULL, previous_code varchar(50),
 outcome text NOT NULL CHECK(outcome IN('published','already-published')),
 published_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(assignment_id,member_id,code) REFERENCES sccrm_member_codes.assignments(assignment_id,member_id,ada_code),
 UNIQUE(assignment_id,outcome)
);
CREATE TABLE IF NOT EXISTS sccrm_member_codes.targets(
 target_id text PRIMARY KEY CHECK(length(target_id) BETWEEN 1 AND 100),
 database_identity varchar(160) NOT NULL UNIQUE CHECK(length(database_identity)>0),
 branch_code varchar(3) NOT NULL CHECK(branch_code ~ '^00[1345]$'),
 enabled boolean NOT NULL DEFAULT false,
 lease_token uuid,lease_owner uuid,lease_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(target_id,database_identity),
 CHECK((lease_token IS NULL AND lease_owner IS NULL AND lease_until IS NULL)
  OR(lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS sccrm_member_codes.jobs(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,target_id text NOT NULL REFERENCES sccrm_member_codes.targets(target_id),
 assignment_id uuid NOT NULL,member_id uuid NOT NULL,hq_code varchar(20) NOT NULL,
 assignment_hash char(64) NOT NULL,assignment jsonb NOT NULL CHECK(jsonb_typeof(assignment)='object'),
 profile jsonb NOT NULL CHECK(jsonb_typeof(profile)='object' AND profile ?& ARRAY['name','phone','email']
  AND profile-ARRAY['name','phone','email']='{}'::jsonb),profile_hash char(64) NOT NULL,
 previous_native_code varchar(20),hq_created_at timestamptz NOT NULL,
 deliver_to_branches boolean NOT NULL DEFAULT true CHECK(deliver_to_branches),
 idempotency_key char(64) NOT NULL UNIQUE CHECK(idempotency_key ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','running','retry','review','succeeded')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid,lease_owner uuid,lease_until timestamptz,
 last_code varchar(80) CHECK(last_code ~ '^[A-Z][A-Z0-9_]{2,79}$'),
 queued_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 UNIQUE(target_id,assignment_id),UNIQUE(target_id,member_id),
 FOREIGN KEY(assignment_id,member_id,hq_code,profile_hash,assignment_hash,deliver_to_branches)
  REFERENCES sccrm_member_codes.assignments(assignment_id,member_id,ada_code,profile_hash,assignment_hash,deliver_to_branches),
 CHECK(previous_native_code IS NULL OR(previous_native_code='SC-'||upper(left(replace(member_id::text,'-',''),16)) AND assignment->>'kind'='approved_existing')),
 CHECK((state='running' AND lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
  OR(state<>'running' AND lease_token IS NULL AND lease_owner IS NULL AND lease_until IS NULL))
);
CREATE INDEX IF NOT EXISTS member_code_due_jobs ON sccrm_member_codes.jobs(target_id,next_attempt_at,id) WHERE state IN('pending','retry','running');
CREATE TABLE IF NOT EXISTS sccrm_member_codes.mappings(
 target_id text NOT NULL,assignment_id uuid NOT NULL,member_id uuid NOT NULL,ada_code varchar(20) NOT NULL,
 assignment_hash char(64) NOT NULL,database_identity varchar(160) NOT NULL,profile_hash char(64) NOT NULL,
 native_receipt jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(target_id,assignment_id),UNIQUE(target_id,member_id),UNIQUE(target_id,ada_code),
 FOREIGN KEY(target_id,database_identity) REFERENCES sccrm_member_codes.targets(target_id,database_identity),
 FOREIGN KEY(target_id,assignment_id) REFERENCES sccrm_member_codes.jobs(target_id,assignment_id),
 FOREIGN KEY(assignment_id,member_id,ada_code,profile_hash,assignment_hash)
  REFERENCES sccrm_member_codes.assignments(assignment_id,member_id,ada_code,profile_hash,assignment_hash)
);
CREATE TABLE IF NOT EXISTS sccrm_member_codes.events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,job_id bigint NOT NULL REFERENCES sccrm_member_codes.jobs(id),
 attempt integer NOT NULL,state text NOT NULL CHECK(state IN('pending','running','retry','review','succeeded')),
 code varchar(80) NOT NULL CHECK(code ~ '^[A-Z][A-Z0-9_]{2,79}$'),occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS member_code_events_job ON sccrm_member_codes.events(job_id,id);
CREATE TABLE IF NOT EXISTS sccrm_member_codes.source_checkpoint(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),created_at timestamptz,
 assignment_id uuid REFERENCES sccrm_member_codes.assignments(assignment_id),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((created_at IS NULL AND assignment_id IS NULL) OR(created_at IS NOT NULL AND assignment_id IS NOT NULL))
);
INSERT INTO sccrm_member_codes.source_checkpoint(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING;
CREATE OR REPLACE FUNCTION sccrm_member_codes.guard_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,sccrm_member_codes AS $$ BEGIN
 RAISE EXCEPTION 'CODE_AUTHORITY_RECORD_IMMUTABLE';
END $$;
DROP TRIGGER IF EXISTS guard_immutable ON sccrm_member_codes.assignments;
CREATE TRIGGER guard_immutable BEFORE UPDATE OR DELETE ON sccrm_member_codes.assignments
 FOR EACH ROW EXECUTE FUNCTION sccrm_member_codes.guard_immutable();
DROP TRIGGER IF EXISTS guard_immutable ON sccrm_member_codes.canonical_codes;
CREATE TRIGGER guard_immutable BEFORE UPDATE OR DELETE ON sccrm_member_codes.canonical_codes
 FOR EACH ROW EXECUTE FUNCTION sccrm_member_codes.guard_immutable();
DROP TRIGGER IF EXISTS guard_immutable ON sccrm_member_codes.aliases;
CREATE TRIGGER guard_immutable BEFORE UPDATE OR DELETE ON sccrm_member_codes.aliases
 FOR EACH ROW EXECUTE FUNCTION sccrm_member_codes.guard_immutable();
DROP TRIGGER IF EXISTS guard_immutable ON sccrm_member_codes.migration_events;
CREATE TRIGGER guard_immutable BEFORE UPDATE OR DELETE ON sccrm_member_codes.migration_events
 FOR EACH ROW EXECUTE FUNCTION sccrm_member_codes.guard_immutable();
DROP TRIGGER IF EXISTS guard_immutable ON sccrm_member_codes.publication_events;
CREATE TRIGGER guard_immutable BEFORE UPDATE OR DELETE ON sccrm_member_codes.publication_events
 FOR EACH ROW EXECUTE FUNCTION sccrm_member_codes.guard_immutable();
DROP TRIGGER IF EXISTS guard_immutable ON sccrm_member_codes.mappings;
CREATE TRIGGER guard_immutable BEFORE UPDATE OR DELETE ON sccrm_member_codes.mappings
 FOR EACH ROW EXECUTE FUNCTION sccrm_member_codes.guard_immutable();
CREATE OR REPLACE FUNCTION sccrm_member_codes.guard_target_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,sccrm_member_codes AS $$ BEGIN
 IF NEW.target_id IS DISTINCT FROM OLD.target_id OR NEW.database_identity IS DISTINCT FROM OLD.database_identity
 OR NEW.branch_code IS DISTINCT FROM OLD.branch_code THEN RAISE EXCEPTION 'ASSIGNED_TARGET_IDENTITY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_target_identity ON sccrm_member_codes.targets;
CREATE TRIGGER guard_target_identity BEFORE UPDATE ON sccrm_member_codes.targets
 FOR EACH ROW EXECUTE FUNCTION sccrm_member_codes.guard_target_identity();
ALTER TABLE sccrm_member_codes.meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_member_codes.assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_member_codes.canonical_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_member_codes.aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_member_codes.migration_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_member_codes.publication_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_member_codes.targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_member_codes.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_member_codes.mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_member_codes.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_member_codes.source_checkpoint ENABLE ROW LEVEL SECURITY;
-- Narrow intentional capability: only the separate authority login may ask
-- the owner to mirror its exact assigned HQ customer. No generic apply_batch
-- EXECUTE or direct mirror/public profile DML is granted to that actor.
CREATE OR REPLACE FUNCTION sccrm_member_codes.refresh_assigned_customer(p_assignment uuid,p_record jsonb,p_snapshot uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,sccrm_member_codes SET lock_timeout='1s' AS $$
DECLARE a record;p jsonb;n integer;existing_member uuid;
BEGIN
 IF session_user::text<>'sccrm_hq_member_code_authority' THEN RAISE EXCEPTION 'CODE_AUTHORITY_ACTOR_REFUSED'; END IF;
 SELECT * INTO a FROM sccrm_member_codes.assignments WHERE assignment_id=p_assignment;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM sccrm_member_codes.meta m WHERE m.singleton=true AND m.expected_hq_identity=a.hq_identity) THEN RAISE EXCEPTION 'LIVE_ASSIGNED_CUSTOMER_REQUIRED'; END IF;
 IF p_snapshot IS NULL OR jsonb_typeof(p_record) IS DISTINCT FROM 'object'
 OR NOT(p_record ?& ARRAY['source_key','owner_code','parent_key','payload_hash','payload'])
 OR p_record-ARRAY['source_key','owner_code','parent_key','payload_hash','payload']<>'{}'::jsonb
 THEN RAISE EXCEPTION 'ASSIGNED_CUSTOMER_RECORD_REFUSED'; END IF;
 p=p_record->'payload';
 IF jsonb_typeof(p) IS DISTINCT FROM 'object'
 OR EXISTS(SELECT 1 FROM jsonb_each(p) e WHERE lower(e.key)~'(pin|password|secret|token)'
  OR jsonb_typeof(e.value)='object'
  OR CASE WHEN jsonb_typeof(e.value)='array' THEN EXISTS(
   SELECT 1 FROM jsonb_array_elements(e.value) b WHERE CASE WHEN b.value::text ~ '^[0-9]{1,3}$'
    THEN b.value::text::numeric>255 ELSE true END) ELSE false END)
 OR p_record->>'source_key' IS DISTINCT FROM a.ada_code OR p_record->>'owner_code' IS DISTINCT FROM a.ada_code
 OR p_record->'parent_key' IS DISTINCT FROM 'null'::jsonb
 OR COALESCE(p_record->>'payload_hash','')!~'^[a-f0-9]{64}$'
 OR p->>'FTCstCode' IS DISTINCT FROM a.ada_code
 OR p->>'FTCstName' IS DISTINCT FROM a.profile->>'name'
 OR p->>'FTCstTel' IS DISTINCT FROM a.profile->>'phone'
 OR COALESCE(p->>'FTCstEmail','') IS DISTINCT FROM a.profile->>'email'
 THEN RAISE EXCEPTION 'ASSIGNED_CUSTOMER_PROFILE_MISMATCH'; END IF;
 PERFORM pg_advisory_xact_lock(731029,12013);
 SELECT member_id INTO existing_member FROM ada_history.member_links WHERE source_id='hq000/AdaAcc' AND ada_code=a.ada_code;
 IF FOUND AND existing_member<>a.member_id THEN RAISE EXCEPTION 'ASSIGNED_MIRROR_OWNER_MISMATCH'; END IF;
 IF EXISTS(SELECT 1 FROM ada_history.customers c WHERE c.source_id='hq000/AdaAcc' AND c.ada_code=a.ada_code
  AND(c.name IS DISTINCT FROM a.profile->>'name' OR c.phone IS DISTINCT FROM a.profile->>'phone'
   OR COALESCE(c.email,'') IS DISTINCT FROM a.profile->>'email'))
 THEN RAISE EXCEPTION 'ASSIGNED_MIRROR_PROFILE_CONFLICT'; END IF;
 n=ada_history.apply_batch('ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b','LIVE-HQ000-ADAACC','customers',jsonb_build_array(p_record),p_snapshot,a.ada_code);
 INSERT INTO ada_history.member_links(member_id,source_id,ada_code,approval_reference)
 VALUES(a.member_id,'hq000/AdaAcc',a.ada_code,'owned HQ assignment '||a.assignment_id::text)
 ON CONFLICT(source_id,ada_code) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM ada_history.member_links WHERE source_id='hq000/AdaAcc' AND ada_code=a.ada_code AND member_id=a.member_id)
 THEN RAISE EXCEPTION 'ASSIGNED_MIRROR_OWNER_MISMATCH'; END IF;
 RETURN n;
END $$;
CREATE OR REPLACE FUNCTION sccrm_member_codes.publish_member_code(p_assignment uuid)
RETURNS TABLE(state text,member_id uuid,member_code text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,sccrm_member_codes SET lock_timeout='1s' AS $$
DECLARE a record;old_code text;alias_reason text;
BEGIN
 IF session_user::text<>'sccrm_hq_member_code_authority' THEN RAISE EXCEPTION 'CODE_AUTHORITY_ACTOR_REFUSED'; END IF;
 SELECT a0.* INTO a FROM sccrm_member_codes.assignments a0 JOIN sccrm_member_codes.canonical_codes c USING(assignment_id,member_id)
 WHERE a0.assignment_id=p_assignment;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM sccrm_member_codes.meta m WHERE m.singleton=true AND m.expected_hq_identity=a.hq_identity) THEN RAISE EXCEPTION 'LIVE_ASSIGNED_CUSTOMER_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM ada_history.member_links l WHERE l.source_id='hq000/AdaAcc' AND l.ada_code=a.ada_code AND l.member_id=a.member_id)
 THEN RETURN QUERY SELECT 'pending-native-link'::text,a.member_id,a.ada_code::text;RETURN; END IF;
 SELECT m.member_code INTO old_code FROM public.member_profiles m WHERE m.user_id=a.member_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ASSIGNED_PUBLIC_MEMBER_MISSING'; END IF;
 IF old_code=a.ada_code THEN
  INSERT INTO sccrm_member_codes.publication_events(assignment_id,member_id,code,previous_code,outcome)
  VALUES(a.assignment_id,a.member_id,a.ada_code,old_code,'already-published') ON CONFLICT(assignment_id,outcome) DO NOTHING;
  RETURN QUERY SELECT 'already-published'::text,a.member_id,a.ada_code::text;RETURN;
 END IF;
 IF old_code='SCM-'||upper(left(replace(a.member_id::text,'-',''),8)) THEN alias_reason='LEGACY_SCCRM_MEMBER_CODE';
 ELSIF old_code='SC-'||upper(left(replace(a.member_id::text,'-',''),16)) THEN alias_reason='LEGACY_OWNED_ADA_CODE';
 ELSE RAISE EXCEPTION 'EXISTING_MEMBER_CODE_REVIEW_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM public.member_profiles m WHERE m.member_code=a.ada_code AND m.user_id<>a.member_id)
 THEN RAISE EXCEPTION 'CANONICAL_PUBLIC_CODE_COLLISION'; END IF;
 INSERT INTO sccrm_member_codes.aliases(code,member_id,assignment_id,reason,approval_reference)
 VALUES(old_code,a.member_id,a.assignment_id,alias_reason,'canonical publication '||a.assignment_id::text) ON CONFLICT(code) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM sccrm_member_codes.aliases x WHERE x.code=old_code AND x.member_id=a.member_id AND x.assignment_id=a.assignment_id)
 THEN RAISE EXCEPTION 'ALIAS_IDENTITY_COLLISION'; END IF;
 UPDATE public.member_profiles m SET member_code=a.ada_code WHERE m.user_id=a.member_id AND m.member_code=old_code;
 IF NOT FOUND THEN RAISE EXCEPTION 'MEMBER_CODE_CHANGED_DURING_PUBLICATION'; END IF;
 INSERT INTO sccrm_member_codes.publication_events(assignment_id,member_id,code,previous_code,outcome)
 VALUES(a.assignment_id,a.member_id,a.ada_code,old_code,'published');
 RETURN QUERY SELECT 'published'::text,a.member_id,a.ada_code::text;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA sccrm_member_codes FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA sccrm_member_codes FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sccrm_member_codes FROM PUBLIC;
-- Intentionally no runtime policies or grants. The coordinator must review
-- separate importer/publication READ and INSERT-only role scopes. This file
-- does not weaken sccrm_fanout checks or grant write access to member profiles.
