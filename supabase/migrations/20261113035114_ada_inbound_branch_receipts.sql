-- Read-only branch sales may have no HQ copy, or the HQ copy may lack its
-- original member code. Keep the physical source in the private mirror. All
-- public history keeps the exact original branch/POS/document/customer identity.
DO $$ BEGIN
 IF (SELECT count(*) FROM ada_history.meta)<>1 OR NOT EXISTS(SELECT 1 FROM ada_history.meta
  WHERE marker='ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b' AND scope='LIVE-HQ000-ADAACC')
 THEN RAISE EXCEPTION 'LIVE_MIRROR_MARKER_REQUIRED';END IF;
END $$;

-- A boolean ownership check is the only new SECURITY DEFINER capability.
-- The runtime gains no direct SELECT privilege on public claims or auth data.
CREATE FUNCTION ada_history.branch_receipt_owner_matches(p_branch text,p_doc text,p_code text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.loyalty_claims l
  WHERE upper(btrim(l.branch_code))=upper(btrim(p_branch)) AND upper(btrim(l.receipt_no))=upper(btrim(p_doc))
   AND l.user_id::text IS DISTINCT FROM COALESCE(
    (SELECT m.member_id FROM ada_history.member_links m WHERE m.source_id='hq000/AdaAcc' AND m.ada_code=p_code),
    md5('hq000/AdaAcc'||chr(31)||p_code)::uuid)::text)
$$;
REVOKE ALL ON FUNCTION ada_history.branch_receipt_owner_matches(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ada_history.branch_receipt_owner_matches(text,text,text) TO sccrm_hq_live_sync;

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
    IF p->>'FTShdStaDoc' IS DISTINCT FROM '1' OR (p->>'FTCstCode') !~ '^AR[0-9]{3}-[0-9]{6}$'
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
REVOKE ALL ON FUNCTION ada_history.apply_source_batch(text,text,text,text,jsonb,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ada_history.apply_source_batch(text,text,text,text,jsonb,uuid,text) TO sccrm_hq_live_sync;
-- Preserve every existing HQ caller and its invoker-only data permissions.
CREATE OR REPLACE FUNCTION ada_history.apply_batch(p_marker text,p_scope text,p_kind text,p_rows jsonb,p_snapshot uuid,p_cursor text)
RETURNS integer LANGUAGE sql SET search_path=pg_catalog AS $$
 SELECT ada_history.apply_source_batch('hq000/AdaAcc',p_marker,p_scope,p_kind,p_rows,p_snapshot,p_cursor)
$$;

CREATE VIEW ada_history.history_receipts AS
 SELECT r.* FROM ada_history.receipts r WHERE r.source_id='hq000/AdaAcc'
 UNION ALL
 SELECT r.* FROM ada_history.receipts r WHERE r.source_id='branch'||r.branch_code||'/AdaAcc'
  AND NOT EXISTS(SELECT 1 FROM ada_history.receipts h WHERE h.source_id='hq000/AdaAcc'
   AND h.branch_code=r.branch_code AND h.pos_code=r.pos_code AND h.doc_type=r.doc_type AND h.doc_no=r.doc_no);
REVOKE ALL ON ada_history.history_receipts FROM PUBLIC;
GRANT SELECT ON ada_history.history_receipts TO sccrm_hq_live_sync;

CREATE OR REPLACE VIEW ada_history.purchase_claims AS
 SELECT 'ada:'||r.receipt_key AS id,COALESCE(ml.member_id,c.directory_id)::text user_id,r.doc_no receipt_no,r.branch_code,
 ((r.sale_date+COALESCE(r.sale_time,'00:00:00'::time)) AT TIME ZONE 'Asia/Bangkok') sold_at,0::numeric total_amount,0::integer awarded_points,
 ((r.sale_date+COALESCE(r.sale_time,'00:00:00'::time)) AT TIME ZONE 'Asia/Bangkok') created_at,
 r.source_payload->>'FTUsrCode' cashier_staff_code,r.grand_total*(CASE WHEN r.doc_type='9' THEN -1 ELSE 1 END) receipt_total_amount,
 jsonb_build_object('version',1,'documentType',CASE WHEN r.doc_type='9' THEN 'return' ELSE 'sale' END,'totalAmountSource','ada_header','posCode',r.pos_code,'receiptCashierCode',r.source_payload->>'FTUsrCode','totalAmount',r.grand_total*(CASE WHEN r.doc_type='9' THEN -1 ELSE 1 END),'items',
 COALESCE((SELECT jsonb_agg(jsonb_build_object('seq',i.seq,'productCode',i.sku,'productName',i.product_name,'barcode',i.barcode,'unitCode',i.unit_code,'unitName',i.unit_name,'qty',i.quantity,'unitPrice',i.unit_price,'lineTotal',i.line_total) ORDER BY i.seq) FROM ada_history.lines i WHERE i.source_id=r.source_id AND i.receipt_key=r.receipt_key),'[]'::jsonb)) receipt_snapshot
 FROM ada_history.history_receipts r JOIN ada_history.customer_profiles c ON c.source_id='hq000/AdaAcc' AND c.ada_code=r.customer_code LEFT JOIN ada_history.member_links ml ON ml.source_id=c.source_id AND ml.ada_code=c.ada_code
 WHERE NOT EXISTS(SELECT 1 FROM public.loyalty_claims lc WHERE UPPER(BTRIM(lc.branch_code))=UPPER(BTRIM(r.branch_code)) AND UPPER(BTRIM(lc.receipt_no))=UPPER(BTRIM(r.doc_no)));


-- One additional destination session for the branch readers. Existing member,
-- HQ recent-receipt and full-history sessions remain independent.
ALTER ROLE sccrm_hq_live_sync CONNECTION LIMIT 4;

-- One call commits each complete source page atomically, including all item
-- chunks. A failed owner/identity/item check leaves no header-only history.
CREATE FUNCTION ada_history.apply_branch_receipt_packet(p_source text,p_marker text,p_scope text,
 p_headers jsonb,p_lines jsonb,p_snapshot uuid) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE batch jsonb;changed integer=0;cursor text;
BEGIN
 IF p_source IS NULL OR p_source !~ '^branch(001|003|004|005)/AdaAcc$'
  OR jsonb_typeof(p_headers) IS DISTINCT FROM 'array' OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_headers) NOT BETWEEN 1 AND 100 OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 5000
 THEN RAISE EXCEPTION 'BRANCH_PACKET_SCOPE_REFUSED';END IF;
 IF (SELECT count(DISTINCT h->'payload'->>'FTShdDocNo') FROM jsonb_array_elements(p_headers) h)<>jsonb_array_length(p_headers)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_headers) h WHERE NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(p_lines) l WHERE l->'payload'->>'FTShdDocNo'=h->'payload'->>'FTShdDocNo'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_lines) l WHERE NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(p_headers) h WHERE h->'payload'->>'FTShdDocNo'=l->'payload'->>'FTShdDocNo'))
 THEN RAISE EXCEPTION 'BRANCH_PACKET_INCOMPLETE';END IF;
 IF EXISTS(SELECT 1 FROM ada_history.lines l WHERE l.source_id=p_source
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_headers) h WHERE h->>'source_key'=l.receipt_key::text)
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_lines) i WHERE i->>'source_key'=l.line_key::text))
 THEN RAISE EXCEPTION 'BRANCH_SOURCE_ITEMS_REMOVED';END IF;
 cursor=p_headers->-1->'payload'->>'FTShdDocNo';
 changed=ada_history.apply_source_batch(p_source,p_marker,p_scope,'receipts',p_headers,p_snapshot,cursor);
 FOR batch IN SELECT jsonb_agg(value ORDER BY ordinal) FROM jsonb_array_elements(p_lines) WITH ORDINALITY e(value,ordinal)
  GROUP BY ((ordinal-1)/100) ORDER BY ((ordinal-1)/100)
 LOOP changed=changed+ada_history.apply_source_batch(p_source,p_marker,p_scope,'lines',batch,p_snapshot,cursor);END LOOP;
 RETURN changed;
END $$;
REVOKE ALL ON FUNCTION ada_history.apply_branch_receipt_packet(text,text,text,jsonb,jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ada_history.apply_branch_receipt_packet(text,text,text,jsonb,jsonb,uuid) TO sccrm_hq_live_sync;
