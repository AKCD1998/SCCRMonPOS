-- Ada has valid legacy native customer codes outside the AR format. Keep
-- the exact existing code; do not assign an AR code or merge by contact data.
DO $$ BEGIN
 IF (SELECT count(*) FROM ada_history.meta)<>1 OR NOT EXISTS(SELECT 1 FROM ada_history.meta
  WHERE marker='ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b' AND scope='LIVE-HQ000-ADAACC')
 THEN RAISE EXCEPTION 'LIVE_MIRROR_MARKER_REQUIRED';END IF;
END $$;
CREATE OR REPLACE FUNCTION ada_history.apply_source_batch(p_source text,p_marker text,p_scope text,p_kind text,p_rows jsonb,p_snapshot uuid,p_cursor text)
RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog,ada_history AS $$
DECLARE r jsonb;p jsonb;existing ada_history.receipts%ROWTYPE;parent ada_history.receipts%ROWTYPE;line_existing ada_history.lines%ROWTYPE;n integer;changed integer=0;d text;source text=p_source;branch text;
BEGIN
 IF source IS NULL OR (source<>'hq000/AdaAcc' AND source !~ '^branch(001|003|004|005)/AdaAcc$') THEN RAISE EXCEPTION 'HISTORY_SOURCE_REFUSED';END IF;
 IF source<>'hq000/AdaAcc' THEN
  branch=substring(source FROM 7 FOR 3);
  IF p_kind IS NULL OR p_kind NOT IN('receipts','lines') THEN RAISE EXCEPTION 'BRANCH_HISTORY_KIND_REFUSED';END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM ada_history.meta WHERE marker=p_marker AND scope=p_scope) OR (SELECT count(*) FROM ada_history.meta)<>1 THEN RAISE EXCEPTION 'MIRROR_TARGET_REFUSED';END IF;
 IF jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows)>100 OR p_kind NOT IN('customers','receipts','lines') THEN RAISE EXCEPTION 'BATCH_SCOPE_REFUSED';END IF;
 PERFORM pg_advisory_xact_lock(731024,1438);
 FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  p=r->'payload';
  IF source<>'hq000/AdaAcc' AND p->>'FTBchCode' IS DISTINCT FROM branch THEN RAISE EXCEPTION 'BRANCH_HISTORY_SCOPE_REFUSED';END IF;
  IF jsonb_typeof(p)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE lower(k)~'(pin|password|secret|token)') OR (r->>'payload_hash')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PAYLOAD_REFUSED';END IF;
  IF p_kind='customers' THEN
   IF (r->>'source_key') IS DISTINCT FROM(p->>'FTCstCode') OR (r->>'owner_code') IS DISTINCT FROM(p->>'FTCstCode') THEN RAISE EXCEPTION 'CUSTOMER_IDENTITY_MISMATCH';END IF;
   INSERT INTO ada_history.change_journal(entity,source_key,old_hash,new_hash) SELECT 'customers',r->>'source_key',payload_hash,r->>'payload_hash' FROM ada_history.customers WHERE source_id=source AND ada_code=p->>'FTCstCode' AND payload_hash<>r->>'payload_hash';
   INSERT INTO ada_history.customers(source_id,ada_code,name,phone,email,branch_code,active,source_payload,payload_hash,source_snapshot) VALUES(source,p->>'FTCstCode',p->>'FTCstName',p->>'FTCstTel',p->>'FTCstEmail',p->>'FTBchCode',p->>'FTCstStaActive',p,r->>'payload_hash',p_snapshot)
   ON CONFLICT(source_id,ada_code) DO UPDATE SET name=EXCLUDED.name,phone=EXCLUDED.phone,email=EXCLUDED.email,branch_code=EXCLUDED.branch_code,active=EXCLUDED.active,source_payload=EXCLUDED.source_payload,payload_hash=EXCLUDED.payload_hash,source_snapshot=EXCLUDED.source_snapshot,updated_at=now() WHERE customers.payload_hash<>EXCLUDED.payload_hash;
  ELSIF p_kind='receipts' THEN
   IF p->>'FTCstCode' IN('','0') OR (r->>'owner_code') IS DISTINCT FROM(p->>'FTCstCode') OR p->>'FTShdStaPaid'<>'3' OR p->>'FTShdDocType' NOT IN('1','9') OR (r->>'source_key')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'RECEIPT_IDENTITY_MISMATCH';END IF;
   IF source<>'hq000/AdaAcc' THEN
    IF p->>'FTShdStaDoc' IS DISTINCT FROM '1' OR (p->>'FTCstCode') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'
    THEN RAISE EXCEPTION 'BRANCH_HISTORY_NOT_FINAL';END IF;
    SELECT * INTO existing FROM ada_history.receipts WHERE source_id='hq000/AdaAcc' AND doc_no=p->>'FTShdDocNo';
    IF FOUND AND (existing.customer_code IS DISTINCT FROM p->>'FTCstCode' OR existing.receipt_key IS DISTINCT FROM r->>'source_key')
    THEN RAISE EXCEPTION 'BRANCH_HQ_OWNER_CONFLICT';END IF;
    IF NOT ada_history.branch_receipt_owner_matches(branch,p->>'FTShdDocNo',p->>'FTCstCode') THEN RAISE EXCEPTION 'BRANCH_CLAIM_OWNER_CONFLICT';END IF;
   END IF;
   SELECT * INTO existing FROM ada_history.receipts WHERE source_id=source AND doc_no=p->>'FTShdDocNo' FOR UPDATE;
   IF FOUND AND(existing.customer_code IS DISTINCT FROM(p->>'FTCstCode') OR existing.receipt_key IS DISTINCT FROM(r->>'source_key') OR existing.branch_code IS DISTINCT FROM(p->>'FTBchCode') OR existing.pos_code IS DISTINCT FROM(p->>'FTPosCode') OR existing.doc_type IS DISTINCT FROM(p->>'FTShdDocType')) THEN RAISE EXCEPTION 'RECEIPT_OWNER_OR_IDENTITY_CHANGE_REFUSED';END IF;
   IF existing.receipt_key IS NOT NULL AND existing.payload_hash<>r->>'payload_hash' THEN INSERT INTO ada_history.change_journal(entity,source_key,old_hash,new_hash) VALUES('receipts',r->>'source_key',existing.payload_hash,r->>'payload_hash');END IF;
   d=left(p->>'FDShdDocDate',10);IF left(d,4)::int BETWEEN 2400 AND 2699 THEN d=((left(d,4)::int)-543)::text||substring(d FROM 5);END IF;
   INSERT INTO ada_history.receipts(source_id,receipt_key,branch_code,pos_code,doc_no,doc_type,customer_code,sale_date,sale_time,raw_sale_date,grand_total,total_before_discount,paid_status,doc_status,refund_status,original_doc_no,source_payload,payload_hash,source_snapshot) VALUES(source,r->>'source_key',p->>'FTBchCode',p->>'FTPosCode',p->>'FTShdDocNo',p->>'FTShdDocType',p->>'FTCstCode',d::date,(p->>'FTShdDocTime')::time,p->>'FDShdDocDate',(p->>'FCShdGrand')::numeric,(p->>'FCShdTotal')::numeric,p->>'FTShdStaPaid',p->>'FTShdStaDoc',p->>'FTShdStaRefund',p->>'FTShdPosCN',p,r->>'payload_hash',p_snapshot)
   ON CONFLICT(source_id,receipt_key) DO UPDATE SET sale_date=EXCLUDED.sale_date,sale_time=EXCLUDED.sale_time,raw_sale_date=EXCLUDED.raw_sale_date,grand_total=EXCLUDED.grand_total,total_before_discount=EXCLUDED.total_before_discount,paid_status=EXCLUDED.paid_status,doc_status=EXCLUDED.doc_status,refund_status=EXCLUDED.refund_status,original_doc_no=EXCLUDED.original_doc_no,source_payload=EXCLUDED.source_payload,payload_hash=EXCLUDED.payload_hash,source_snapshot=EXCLUDED.source_snapshot,updated_at=now() WHERE receipts.payload_hash<>EXCLUDED.payload_hash;
  ELSE
   SELECT * INTO parent FROM ada_history.receipts WHERE source_id=source AND doc_no=p->>'FTShdDocNo';
   IF NOT FOUND OR parent.receipt_key IS DISTINCT FROM(r->>'parent_key') OR parent.customer_code IS DISTINCT FROM(r->>'owner_code') OR(COALESCE(p->>'FTBchCode','')<>'' AND p->>'FTBchCode'<>parent.branch_code) OR(COALESCE(p->>'FTShdDocType','')<>'' AND p->>'FTShdDocType'<>parent.doc_type) THEN RAISE EXCEPTION 'LINE_OWNER_OR_IDENTITY_MISMATCH';END IF;
   SELECT * INTO line_existing FROM ada_history.lines WHERE source_id=source AND line_key=(r->>'source_key')::char(64);
   IF FOUND AND(line_existing.receipt_key<>parent.receipt_key OR line_existing.seq<>(p->>'FNSdtSeqNo')::bigint) THEN RAISE EXCEPTION 'LINE_OWNER_OR_IDENTITY_MISMATCH';END IF;
   INSERT INTO ada_history.change_journal(entity,source_key,old_hash,new_hash) SELECT 'lines',r->>'source_key',payload_hash,r->>'payload_hash' FROM ada_history.lines WHERE source_id=source AND line_key=(r->>'source_key')::char(64) AND payload_hash<>r->>'payload_hash';
   INSERT INTO ada_history.lines(source_id,line_key,receipt_key,seq,sku,product_name,barcode,unit_code,unit_name,quantity,quantity_base,unit_price,line_total,item_status,refund_status,source_payload,payload_hash,source_snapshot) VALUES(source,r->>'source_key',parent.receipt_key,(p->>'FNSdtSeqNo')::bigint,p->>'FTPdtCode',p->>'FTPdtName',p->>'FTSdtBarCode',p->>'FTPunCode',p->>'FTSdtUnitName',(p->>'FCSdtQty')::numeric,(p->>'FCSdtQtyAll')::numeric,(p->>'FCSdtSalePrice')::numeric,(p->>'FCSdtNet')::numeric,p->>'FTSdtStaPdt',p->>'FTSdtStaRfd',p,r->>'payload_hash',p_snapshot)
   ON CONFLICT(source_id,line_key) DO UPDATE SET sku=EXCLUDED.sku,product_name=EXCLUDED.product_name,barcode=EXCLUDED.barcode,unit_code=EXCLUDED.unit_code,unit_name=EXCLUDED.unit_name,quantity=EXCLUDED.quantity,quantity_base=EXCLUDED.quantity_base,unit_price=EXCLUDED.unit_price,line_total=EXCLUDED.line_total,item_status=EXCLUDED.item_status,refund_status=EXCLUDED.refund_status,source_payload=EXCLUDED.source_payload,payload_hash=EXCLUDED.payload_hash,source_snapshot=EXCLUDED.source_snapshot,updated_at=now() WHERE lines.payload_hash<>EXCLUDED.payload_hash;
  END IF;
  GET DIAGNOSTICS n=ROW_COUNT;changed=changed+n;
 END LOOP;
 INSERT INTO ada_history.checkpoints(snapshot_id,kind,last_key) VALUES(p_snapshot,p_kind,p_cursor) ON CONFLICT(snapshot_id,kind) DO UPDATE SET last_key=EXCLUDED.last_key,updated_at=now();
 RETURN changed;
END $$;

-- A later HQ arrival must not silently replace a branch bill's original owner.
CREATE INDEX history_receipt_doc_sources ON ada_history.receipts(doc_no);
CREATE FUNCTION ada_history.check_cross_source_receipt_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(731024,1438);
 IF EXISTS(SELECT 1 FROM ada_history.receipts r WHERE r.doc_no=NEW.doc_no AND r.source_id<>NEW.source_id
  AND r.source_id IN('hq000/AdaAcc','branch001/AdaAcc','branch003/AdaAcc','branch004/AdaAcc','branch005/AdaAcc')
  AND (r.customer_code IS DISTINCT FROM NEW.customer_code OR r.receipt_key IS DISTINCT FROM NEW.receipt_key
   OR r.branch_code IS DISTINCT FROM NEW.branch_code OR r.pos_code IS DISTINCT FROM NEW.pos_code OR r.doc_type IS DISTINCT FROM NEW.doc_type))
 THEN RAISE EXCEPTION 'CROSS_SOURCE_RECEIPT_OWNER_CONFLICT';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ada_history.check_cross_source_receipt_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ada_history.check_cross_source_receipt_owner() TO sccrm_hq_live_sync;
CREATE TRIGGER history_cross_source_owner BEFORE INSERT OR UPDATE ON ada_history.receipts
 FOR EACH ROW EXECUTE FUNCTION ada_history.check_cross_source_receipt_owner();
