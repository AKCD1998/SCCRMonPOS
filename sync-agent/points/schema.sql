-- Private projection storage only. Runtime/API roles are provisioned separately.
CREATE SCHEMA IF NOT EXISTS ada_points;
DO $$ BEGIN
 IF to_regclass('ada_points.meta') IS NULL THEN
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ada_points') THEN
   RAISE EXCEPTION 'POINT_STORE_SCHEMA_COLLISION';
  END IF;
 ELSE
  IF (SELECT count(*) FROM ada_points.meta)<>1 OR NOT EXISTS(
   SELECT 1 FROM ada_points.meta WHERE singleton AND schema_version=1
    AND scope='SCCRM-ADA-PRIMARY-POINTS-V1' AND marker='541be1f2-1b99-4d73-9d6a-5ef0a1ef2417'
  ) THEN RAISE EXCEPTION 'POINT_STORE_SCHEMA_NOT_OWNED';END IF;
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS ada_points.meta(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 schema_version integer NOT NULL CHECK(schema_version=1),
 scope text NOT NULL CHECK(scope='SCCRM-ADA-PRIMARY-POINTS-V1'),
 marker uuid NOT NULL CHECK(marker='541be1f2-1b99-4d73-9d6a-5ef0a1ef2417')
);
INSERT INTO ada_points.meta(singleton,schema_version,scope,marker)
 VALUES(true,1,'SCCRM-ADA-PRIMARY-POINTS-V1','541be1f2-1b99-4d73-9d6a-5ef0a1ef2417') ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS ada_points.sources(
 branch_code varchar(3) PRIMARY KEY CHECK(branch_code IN('000','001','003','004','005')),
 source_identity text NOT NULL UNIQUE,machine text NOT NULL,database_name text NOT NULL,
 schema_hash char(64) NOT NULL CHECK(schema_hash~'^[a-f0-9]{64}$'),
 view_hash char(64) NOT NULL CHECK(view_hash~'^[a-f0-9]{64}$'),
 observed_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS ada_points.source_snapshots(
 branch_code varchar(3) PRIMARY KEY REFERENCES ada_points.sources(branch_code),
 payload_hash char(64) NOT NULL CHECK(payload_hash~'^[a-f0-9]{64}$'),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),observed_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS ada_points.source_audit(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 branch_code varchar(3) NOT NULL REFERENCES ada_points.sources(branch_code),
 payload_hash char(64) NOT NULL,source_identity text NOT NULL,schema_hash char(64) NOT NULL,
 observed_at timestamptz NOT NULL,customer_count integer NOT NULL,point_count integer NOT NULL,
 balance_count integer NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS ada_points.source_openings(
 branch_code varchar(3) NOT NULL REFERENCES ada_points.sources(branch_code),
 ada_code varchar(20) NOT NULL,initial_opening text,
 first_payload_hash char(64) NOT NULL CHECK(first_payload_hash~'^[a-f0-9]{64}$'),
 first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(branch_code,ada_code)
);
CREATE TABLE IF NOT EXISTS ada_points.native_events(
 event_key char(64) PRIMARY KEY CHECK(event_key~'^[a-f0-9]{64}$'),
 owner_key_hash char(64) NOT NULL CHECK(owner_key_hash~'^[a-f0-9]{64}$'),
 origin_branch text NOT NULL,ada_code text NOT NULL,doc_no text NOT NULL,supplier_code text NOT NULL,
 business_hash char(64) NOT NULL CHECK(business_hash~'^[a-f0-9]{64}$'),
 card_type text,points bigint,contribution bigint,expired varchar(1),processed varchar(1),active boolean NOT NULL,
 state text NOT NULL CHECK(state IN('ready','review','retired')),
 sources text[] NOT NULL CHECK(cardinality(sources)>0),
 business_payload jsonb NOT NULL CHECK(jsonb_typeof(business_payload)='object'),
 review_reasons text[] NOT NULL DEFAULT '{}',
 first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(origin_branch,ada_code,doc_no,supplier_code)
);
CREATE INDEX IF NOT EXISTS ada_points_native_owner ON ada_points.native_events(owner_key_hash);
CREATE INDEX IF NOT EXISTS ada_points_native_customer ON ada_points.native_events(ada_code);
-- Global sequence supplies a monotonic generation for every native code.
-- Gaps after a rolled-back transaction are intentional; generations never reuse.
CREATE SEQUENCE IF NOT EXISTS ada_points.balance_generation_seq AS bigint MINVALUE 1 START 1;
CREATE TABLE IF NOT EXISTS ada_points.balance_values(
 ada_code varchar(20) PRIMARY KEY,
 balance numeric(38,17),state text NOT NULL CHECK(state IN('ready','review')),
 version char(64) NOT NULL CHECK(version~'^[a-f0-9]{64}$'),
 generation bigint NOT NULL DEFAULT nextval('ada_points.balance_generation_seq') CHECK(generation>0),
 details jsonb NOT NULL CHECK(jsonb_typeof(details)='object'),
 CHECK((state='ready' AND balance IS NOT NULL) OR(state='review' AND balance IS NULL))
);
ALTER TABLE ada_points.balance_values ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT nextval('ada_points.balance_generation_seq') CHECK(generation>0);
CREATE TABLE IF NOT EXISTS ada_points.projection_journal(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,ada_code varchar(20) NOT NULL,
 old_value jsonb,new_value jsonb NOT NULL,
 revision char(64) NOT NULL CHECK(revision~'^[a-f0-9]{64}$'),
 generation bigint NOT NULL CHECK(generation>0),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- A pre-generation local copy may retain older audit entries; new writes always
-- carry a generation, while historical rows are not rewritten or fabricated.
ALTER TABLE ada_points.projection_journal ADD COLUMN IF NOT EXISTS generation bigint CHECK(generation>0);
CREATE TABLE IF NOT EXISTS ada_points.global_state(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),observed_at timestamptz,
 state text NOT NULL CHECK(state IN('ready','review')),
 revision char(64) CHECK(revision IS NULL OR revision~'^[a-f0-9]{64}$'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO ada_points.global_state(singleton,state) VALUES(true,'review') ON CONFLICT(singleton) DO NOTHING;
CREATE OR REPLACE VIEW ada_points.balance_cache WITH(security_invoker=true) AS
 SELECT v.ada_code,CASE WHEN g.state='ready' THEN v.balance ELSE NULL END AS balance,
 CASE WHEN g.state='ready' THEN v.state ELSE 'review' END AS state,g.observed_at
 FROM ada_points.balance_values v CROSS JOIN ada_points.global_state g WHERE g.singleton;
DO $$ DECLARE t text;r text;BEGIN
 FOREACH t IN ARRAY ARRAY['meta','sources','source_snapshots','source_audit','source_openings','native_events','balance_values','projection_journal','global_state'] LOOP
  EXECUTE format('ALTER TABLE ada_points.%I ENABLE ROW LEVEL SECURITY',t);
 END LOOP;
 REVOKE ALL ON SCHEMA ada_points FROM PUBLIC;
 REVOKE ALL ON ALL TABLES IN SCHEMA ada_points FROM PUBLIC;
 REVOKE ALL ON ALL SEQUENCES IN SCHEMA ada_points FROM PUBLIC;
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON SCHEMA ada_points FROM %I',r);
   EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ada_points FROM %I',r);
   EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA ada_points FROM %I',r);
  END IF;
 END LOOP;
END $$;
-- No broad policies or grants are installed here. A future explicitly provisioned
-- API reader needs USAGE and SELECT/policies on balance_cache, balance_values and
-- global_state because the view uses the caller's RLS rights. A separately scoped
-- receipt-status reader also needs explicit SELECT/policy on native_events.
