-- A paid HQ bill can arrive before its original branch customer profile.
-- Keep that profile in a separate, provenance-labelled read cache. Never insert
-- it into the native HQ customer mirror or infer an approved SCCRM member link.
DO $$ BEGIN
 IF (SELECT count(*) FROM ada_history.meta)<>1 OR NOT EXISTS(SELECT 1 FROM ada_history.meta
  WHERE marker='ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b' AND scope='LIVE-HQ000-ADAACC')
 THEN RAISE EXCEPTION 'LIVE_MIRROR_MARKER_REQUIRED'; END IF;
END $$;
CREATE TABLE ada_history.branch_customer_profiles(
 branch_code text NOT NULL CHECK(branch_code IN('001','003','004','005')),
 ada_code varchar(20) NOT NULL CHECK(ada_code ~ '^AR[0-9]{3}-[0-9]{6}$'),
 native_source_id text GENERATED ALWAYS AS ('branch'||branch_code||'/AdaAcc') STORED,
 name text,phone text,email text,active text,
 source_payload jsonb NOT NULL,payload_hash char(64) NOT NULL,source_snapshot uuid NOT NULL,
 evidence_receipt_key char(64) NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(branch_code,ada_code),UNIQUE(ada_code),
 CHECK(left(ada_code,5)='AR'||branch_code),
 CHECK(source_payload->>'FTCstCode'=ada_code),
 CHECK(source_payload->>'FTBchCode'=branch_code)
);
ALTER TABLE ada_history.branch_customer_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY hq_history_branch_profile ON ada_history.branch_customer_profiles TO sccrm_hq_live_sync
 USING(true) WITH CHECK(true);
REVOKE ALL ON ada_history.branch_customer_profiles FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON ada_history.branch_customer_profiles TO sccrm_hq_live_sync;

-- The directory ID uses the existing history namespace so an eventual exact
-- HQ profile arrival keeps bookmarks and bill ownership stable. The physical
-- native source remains explicit and HQ always takes precedence.
CREATE VIEW ada_history.customer_profiles AS
 SELECT c.source_id,c.ada_code,c.name,c.phone,c.email,c.branch_code,c.active,
  c.source_payload,c.payload_hash,c.source_snapshot,c.updated_at,c.directory_id,
  c.source_id AS native_source_id,'hq'::text AS profile_origin
 FROM ada_history.customers c
 UNION ALL
 SELECT 'hq000/AdaAcc',b.ada_code,b.name,b.phone,b.email,b.branch_code,b.active,
  b.source_payload,b.payload_hash,b.source_snapshot,b.updated_at,
  md5('hq000/AdaAcc'||chr(31)||b.ada_code)::uuid,b.native_source_id,'branch'
 FROM ada_history.branch_customer_profiles b
 WHERE NOT EXISTS(SELECT 1 FROM ada_history.customers c WHERE c.source_id='hq000/AdaAcc' AND c.ada_code=b.ada_code);
REVOKE ALL ON ada_history.customer_profiles FROM PUBLIC;
GRANT SELECT ON ada_history.customer_profiles TO sccrm_hq_live_sync;

CREATE FUNCTION ada_history.apply_branch_customer_profile(
 p_marker text,p_scope text,p_branch text,p_customer jsonb,p_hash text,p_snapshot uuid,p_header jsonb
) RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE code text;receipt char(64);n integer;
BEGIN
 IF (SELECT count(*) FROM ada_history.meta)<>1 OR NOT EXISTS(SELECT 1 FROM ada_history.meta WHERE marker=p_marker AND scope=p_scope)
 THEN RAISE EXCEPTION 'MIRROR_TARGET_REFUSED'; END IF;
 code=p_customer->>'FTCstCode';
 IF p_branch IS NULL OR p_branch NOT IN('001','003','004','005') OR code IS NULL
  OR code !~ ('^AR'||p_branch||'-[0-9]{6}$') OR p_customer->>'FTBchCode' IS DISTINCT FROM p_branch
  OR jsonb_typeof(p_customer) IS DISTINCT FROM 'object' OR p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_customer) k WHERE lower(k)~'(pin|password|secret|token)')
  OR p_header->>'FTCstCode' IS DISTINCT FROM code OR p_header->>'FTBchCode' IS DISTINCT FROM p_branch
  OR p_header->>'FTShdStaPaid' IS DISTINCT FROM '3'
 THEN RAISE EXCEPTION 'BRANCH_CUSTOMER_SCOPE_REFUSED'; END IF;
 SELECT r.receipt_key INTO receipt FROM ada_history.receipts r
 WHERE r.source_id='hq000/AdaAcc' AND r.branch_code=p_branch AND r.customer_code=code
  AND r.doc_no=p_header->>'FTShdDocNo' AND r.pos_code=p_header->>'FTPosCode'
  AND r.doc_type=p_header->>'FTShdDocType' AND r.paid_status='3'
  AND r.grand_total IS NOT DISTINCT FROM (p_header->>'FCShdGrand')::numeric
  AND r.raw_sale_date=p_header->>'FDShdDocDate' AND r.sale_time=(p_header->>'FTShdDocTime')::time;
 IF receipt IS NULL THEN RAISE EXCEPTION 'BRANCH_RECEIPT_PROOF_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM ada_history.customers c WHERE c.source_id='hq000/AdaAcc' AND c.ada_code=code) THEN RETURN 0; END IF;
 INSERT INTO ada_history.branch_customer_profiles(branch_code,ada_code,name,phone,email,active,source_payload,payload_hash,source_snapshot,evidence_receipt_key)
 VALUES(p_branch,code,p_customer->>'FTCstName',p_customer->>'FTCstTel',p_customer->>'FTCstEmail',p_customer->>'FTCstStaActive',p_customer,p_hash,p_snapshot,receipt)
 ON CONFLICT(branch_code,ada_code) DO UPDATE SET name=EXCLUDED.name,phone=EXCLUDED.phone,email=EXCLUDED.email,
  active=EXCLUDED.active,source_payload=EXCLUDED.source_payload,payload_hash=EXCLUDED.payload_hash,
  source_snapshot=EXCLUDED.source_snapshot,evidence_receipt_key=EXCLUDED.evidence_receipt_key,updated_at=now()
 WHERE branch_customer_profiles.payload_hash<>EXCLUDED.payload_hash;
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n;
END $$;
REVOKE ALL ON FUNCTION ada_history.apply_branch_customer_profile(text,text,text,jsonb,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ada_history.apply_branch_customer_profile(text,text,text,jsonb,text,uuid,jsonb) TO sccrm_hq_live_sync;

-- Retain the deployed phone precedence, deduplication, return semantics and
-- access grants verbatim. Only the customer read source changes in these views.
DO $$
DECLARE target text;definition text;
BEGIN
 FOREACH target IN ARRAY ARRAY['ada_history.directory','ada_history.purchase_claims'] LOOP
  definition=pg_get_viewdef(target::regclass,true);
  IF position('ada_history.customers c' IN definition)=0 THEN RAISE EXCEPTION 'HISTORY_VIEW_CONTRACT_REFUSED'; END IF;
  EXECUTE format('CREATE OR REPLACE VIEW %s AS %s',target,replace(definition,'ada_history.customers c','ada_history.customer_profiles c'));
 END LOOP;
END $$;
