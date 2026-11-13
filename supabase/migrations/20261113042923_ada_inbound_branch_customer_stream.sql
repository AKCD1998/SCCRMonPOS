-- A member born at its originating Ada branch may buy at another branch.
-- Require the exact verified native receipt and original home-branch code;
-- the private profile remains separate from native HQ rows and approved links.
DO $$ BEGIN
 IF (SELECT count(*) FROM ada_history.meta)<>1 OR NOT EXISTS(SELECT 1 FROM ada_history.meta
  WHERE marker='ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b' AND scope='LIVE-HQ000-ADAACC')
 THEN RAISE EXCEPTION 'LIVE_MIRROR_MARKER_REQUIRED';END IF;
END $$;
CREATE OR REPLACE FUNCTION ada_history.apply_branch_customer_profile(
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
  OR p_header->>'FTCstCode' IS DISTINCT FROM code OR p_header->>'FTBchCode' IS NULL OR p_header->>'FTBchCode' NOT IN('001','003','004','005')
  OR p_header->>'FTShdStaPaid' IS DISTINCT FROM '3'
 THEN RAISE EXCEPTION 'BRANCH_CUSTOMER_SCOPE_REFUSED'; END IF;
 SELECT r.receipt_key INTO receipt FROM ada_history.history_receipts r
 WHERE r.branch_code=p_header->>'FTBchCode' AND r.customer_code=code
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
