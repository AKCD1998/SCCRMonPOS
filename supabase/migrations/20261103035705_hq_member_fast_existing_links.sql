-- Additive, private capabilities for the existing restricted HQ service.
-- Never writes Ada, bills, points, user contacts or authentication credentials.
-- A legacy synthetic contact may be retired only after an exact name+phone
-- match and proof that it has no login, sessions, claims or customer records.
CREATE FUNCTION ada_history.member_name_key(p_value text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT lower(regexp_replace(regexp_replace(btrim(coalesce(p_value,'')),
  '^(นาย|นางสาว|นาง)[[:space:]]*','','g'),'[[:space:]]','','g'))
$$;
CREATE FUNCTION ada_history.local_member_phone(p_value text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN d ~ '^66[0-9]{9}$' THEN '0'||substring(d FROM 3) ELSE d END
 FROM(SELECT regexp_replace(coalesce(p_value,''),'[^0-9]','','g') d) x
$$;
CREATE FUNCTION ada_history.existing_member_candidate(p_member uuid)
RETURNS TABLE(ada_code text,resolution_mode text,imported_member uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='1s' AS $$
DECLARE u record;n integer;owners integer;all_owned boolean;owner_id uuid;code text;self_count integer;
BEGIN
 IF session_user::text<>'sccrm_hq_live_sync' OR NOT EXISTS(SELECT 1 FROM ada_history.meta
  WHERE marker='ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b' AND scope='LIVE-HQ000-ADAACC')
 THEN RAISE EXCEPTION 'MEMBER_LINK_ACTOR_REFUSED';END IF;
 SELECT a.id,a.full_name,a.phone_number,a.email,a.dob,a.sex,m.member_code INTO u FROM public.users a
 JOIN public.member_profiles m ON m.user_id=a.id WHERE a.id=p_member AND m.is_active=true;
 IF NOT FOUND OR u.member_code<>'SCM-'||upper(left(replace(p_member::text,'-',''),8))
  OR ada_history.local_member_phone(u.phone_number)!~'^0[0-9]{9}$'
  OR EXISTS(SELECT 1 FROM sccrm_member_codes.assignments a WHERE a.member_id=p_member)
 THEN RETURN;END IF;
 SELECT count(*)::int INTO self_count FROM ada_history.member_links l WHERE l.member_id=p_member;
 IF self_count=1 THEN
  RETURN QUERY SELECT l.ada_code::text,'approved'::text,NULL::uuid FROM ada_history.member_links l
  JOIN ada_history.customers c USING(source_id,ada_code)
  WHERE l.member_id=p_member AND l.source_id='hq000/AdaAcc'
   AND c.active='1'
   AND l.ada_code ~ '^AR(000|001|003|004|005)-[0-9]{6}$' AND btrim(l.approval_reference)<>''
   AND l.approval_reference<>'native create acknowledgement'
   AND l.approval_reference NOT LIKE 'owned HQ assignment %';RETURN;
 ELSIF self_count<>0 THEN RETURN;END IF;
 WITH candidates AS (
  SELECT c.ada_code,l.member_id FROM ada_history.customers c
  LEFT JOIN ada_history.member_links l USING(source_id,ada_code)
  WHERE c.source_id='hq000/AdaAcc' AND c.active='1'
   AND c.ada_code ~ '^AR(000|001|003|004|005)-[0-9]{6}$'
   AND c.source_payload->>'FTCstBusiness'='1'
   AND coalesce(c.source_payload->>'FTWhoIns','') NOT IN('SCCRM_SYNC_CREATE','SCCRM_FANOUT_CREATE')
   AND c.name !~ '(บริษัท|หจก|ห้างหุ้นส่วน|นิติบุคคล|เลขภาษี|ที่อยู่[[:space:]]*[0-9]|[(]นบ[.)])'
   AND ada_history.member_name_key(c.name)=ada_history.member_name_key(u.full_name)
   AND ada_history.local_member_phone(c.phone) LIKE '%'||ada_history.local_member_phone(u.phone_number)||'%'
   AND(NULLIF(lower(btrim(c.email)),'') IS NULL OR NULLIF(lower(btrim(u.email)),'') IS NULL OR lower(btrim(c.email))=lower(btrim(u.email)))
   AND(u.dob IS NULL OR NULLIF(c.source_payload->>'FDCstDob','') IS NULL
    OR left(c.source_payload->>'FDCstDob',10)=u.dob::text
    OR left(c.source_payload->>'FDCstDob',10)=left(c.source_payload->>'FDDateIns',10))
   AND(NULLIF(u.sex,'') IS NULL OR NULLIF(c.source_payload->>'FTCstSex','') IS NULL OR u.sex=c.source_payload->>'FTCstSex')
 ) SELECT count(*)::int,count(DISTINCT v.member_id)::int,count(*)=count(v.member_id),
  min(v.member_id::text)::uuid,min(v.ada_code)::text INTO n,owners,all_owned,owner_id,code FROM candidates v;
 IF n=0 THEN RETURN;END IF;
 IF n=1 AND owners=0 THEN RETURN QUERY SELECT code,'exact'::text,NULL::uuid;RETURN;END IF;
 IF NOT all_owned OR owners<>1 THEN RETURN;END IF;
 SELECT m.member_code INTO code FROM public.users a JOIN public.member_profiles m ON m.user_id=a.id
 JOIN ada_history.customers c ON c.source_id='hq000/AdaAcc' AND c.ada_code=m.member_code
 WHERE a.id=owner_id AND a.id=c.directory_id AND m.is_active=true
  AND a.email IS NULL AND a.phone_number IS NULL AND a.is_verified=false AND a.password_hash IS NULL
  AND c.active='1' AND c.source_payload->>'FTCstBusiness'='1'
  AND ada_history.member_name_key(c.name)=ada_history.member_name_key(u.full_name)
  AND ada_history.local_member_phone(c.phone) LIKE '%'||ada_history.local_member_phone(u.phone_number)||'%'
  AND(NULLIF(lower(btrim(c.email)),'') IS NULL OR NULLIF(lower(btrim(u.email)),'') IS NULL OR lower(btrim(c.email))=lower(btrim(u.email)))
  AND(u.dob IS NULL OR NULLIF(c.source_payload->>'FDCstDob','') IS NULL
   OR left(c.source_payload->>'FDCstDob',10)=u.dob::text OR left(c.source_payload->>'FDCstDob',10)=left(c.source_payload->>'FDDateIns',10))
  AND(NULLIF(u.sex,'') IS NULL OR NULLIF(c.source_payload->>'FTCstSex','') IS NULL OR u.sex=c.source_payload->>'FTCstSex')
  AND NOT EXISTS(SELECT 1 FROM sccrm_member_codes.assignments a2 WHERE a2.member_id=owner_id OR a2.ada_code=m.member_code);
 IF FOUND THEN RETURN QUERY SELECT code,'imported'::text,owner_id;END IF;
END $$;
CREATE FUNCTION ada_history.pending_approved_member_links(p_limit integer DEFAULT 20)
RETURNS TABLE(id uuid,full_name text,phone_number text,email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF session_user::text<>'sccrm_hq_live_sync' OR p_limit NOT BETWEEN 1 AND 100
 THEN RAISE EXCEPTION 'MEMBER_LINK_ACTOR_REFUSED';END IF;
 RETURN QUERY SELECT u.id,u.full_name::text,u.phone_number::text,u.email::text
 FROM public.users u JOIN public.member_profiles m ON m.user_id=u.id
 WHERE m.is_active=true AND m.member_code='SCM-'||upper(left(replace(u.id::text,'-',''),8))
  AND EXISTS(SELECT 1 FROM ada_history.member_links l WHERE l.member_id=u.id
   AND l.source_id='hq000/AdaAcc' AND l.ada_code ~ '^AR(000|001|003|004|005)-[0-9]{6}$'
   AND l.approval_reference<>'native create acknowledgement'
   AND l.approval_reference NOT LIKE 'owned HQ assignment %')
  AND(SELECT count(*) FROM ada_history.member_links l WHERE l.member_id=u.id)=1
  AND NOT EXISTS(SELECT 1 FROM sccrm_member_codes.assignments a WHERE a.member_id=u.id)
 ORDER BY u.created_at,u.id LIMIT p_limit;
END $$;
CREATE FUNCTION ada_history.resolve_existing_member(p_member uuid,p_code text,p_source_hash text,p_member_hash text)
RETURNS TABLE(state text,member_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='1s' AS $$
DECLARE u record;c record;choice record;old_profile public.member_profiles%ROWTYPE;
 old_code text;owner_id uuid;aid uuid;assigned timestamptz;assigned_text text;ph text;ah text;
 profile jsonb;v_phone text;name text;email text;ref text;expected_hash text;
 hq constant text='hq000/SERVER.SQLEXPRESS/AdaAcc/64fa3170-80ae-45ee-b9f3-7478b2a46e34';
BEGIN
 IF session_user::text<>'sccrm_hq_live_sync' OR p_code !~ '^AR(000|001|003|004|005)-[0-9]{6}$'
  OR p_source_hash!~'^[a-f0-9]{64}$' OR p_member_hash!~'^[a-f0-9]{64}$'
  OR NOT EXISTS(SELECT 1 FROM ada_history.meta WHERE marker='ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b' AND scope='LIVE-HQ000-ADAACC')
  OR NOT EXISTS(SELECT 1 FROM sccrm_member_codes.meta WHERE singleton=true
   AND marker='cffb05d6-116a-458d-98ba-52473745c116' AND schema_version=1 AND expected_hq_identity=hq)
 THEN RAISE EXCEPTION 'MEMBER_LINK_SCOPE_REFUSED';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('ada-link-member:'||p_member::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('ada-link-code:hq000/AdaAcc:'||p_code,0));
 SELECT a.id,a.full_name,a.phone_number,a.email,m.member_code INTO u FROM public.users a
 JOIN public.member_profiles m ON m.user_id=a.id WHERE a.id=p_member AND m.is_active=true FOR UPDATE OF a,m;
 IF NOT FOUND THEN RAISE EXCEPTION 'MEMBER_LINK_MEMBER_CHANGED';END IF;
 expected_hash=encode(sha256(convert_to('{"email":'||coalesce(to_json(u.email)::text,'null')||
  ',"name":'||coalesce(to_json(u.full_name)::text,'null')||',"phone":'||coalesce(to_json(u.phone_number)::text,'null')||'}','UTF8')),'hex');
 IF p_member_hash<>expected_hash THEN RAISE EXCEPTION 'MEMBER_LINK_MEMBER_CHANGED';END IF;
 SELECT * INTO c FROM ada_history.customers x WHERE x.source_id='hq000/AdaAcc' AND x.ada_code=p_code FOR UPDATE;
 IF NOT FOUND OR c.payload_hash<>p_source_hash OR c.active IS DISTINCT FROM '1'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(c.source_payload) k WHERE lower(k)~'(pin|password|secret|token)')
 THEN RAISE EXCEPTION 'MEMBER_LINK_SOURCE_CHANGED';END IF;
 v_phone=ada_history.local_member_phone(u.phone_number);name=btrim(c.name);email=lower(btrim(coalesce(c.email,'')));
 IF v_phone!~'^0[0-9]{9}$' OR ada_history.local_member_phone(c.phone) NOT LIKE '%'||v_phone||'%'
  OR name='' OR length(name)>200 OR length(email)>100
 THEN RAISE EXCEPTION 'MEMBER_LINK_PROFILE_REVIEW';END IF;
 IF u.member_code=p_code AND EXISTS(SELECT 1 FROM ada_history.member_links l WHERE l.member_id=p_member AND l.source_id='hq000/AdaAcc' AND l.ada_code=p_code)
  AND EXISTS(SELECT 1 FROM sccrm_member_codes.assignments a WHERE a.member_id=p_member AND a.ada_code=p_code AND a.kind='approved_existing' AND a.deliver_to_branches=false)
 THEN RETURN QUERY SELECT 'already-linked'::text,p_code;RETURN;END IF;
 old_code='SCM-'||upper(left(replace(p_member::text,'-',''),8));
 IF u.member_code<>old_code THEN RAISE EXCEPTION 'MEMBER_LINK_EXISTING_CODE_REVIEW';END IF;
 SELECT * INTO choice FROM ada_history.existing_member_candidate(p_member);
 IF NOT FOUND OR choice.ada_code<>p_code THEN RAISE EXCEPTION 'MEMBER_LINK_IDENTITY_REVIEW';END IF;
 owner_id=choice.imported_member;
 IF owner_id IS NOT NULL THEN
  SELECT * INTO old_profile FROM public.member_profiles m WHERE m.user_id=owner_id AND m.is_active=true FOR UPDATE;
  IF NOT FOUND OR old_profile.member_code<>p_code OR EXISTS(SELECT 1 FROM public.users a WHERE a.id=owner_id
   AND(a.phone_number IS NOT NULL OR a.email IS NOT NULL OR a.is_verified=true OR a.password_hash IS NOT NULL))
   OR EXISTS(SELECT 1 FROM public.crm_member_consents x WHERE x.user_id=owner_id)
   OR EXISTS(SELECT 1 FROM public.crm_member_health_records x WHERE x.user_id=owner_id)
   OR EXISTS(SELECT 1 FROM public.member_portal_sessions x WHERE x.user_id=owner_id)
   OR EXISTS(SELECT 1 FROM public.point_ledger x WHERE x.user_id=owner_id)
   OR EXISTS(SELECT 1 FROM public.loyalty_claims x WHERE x.user_id=owner_id)
   OR EXISTS(SELECT 1 FROM public.transactions x WHERE x.user_id=owner_id)
   OR EXISTS(SELECT 1 FROM public.redemptions x WHERE x.user_id=owner_id)
   OR EXISTS(SELECT 1 FROM public.crm_sale_claims x WHERE x.customer_account_id=owner_id)
   OR EXISTS(SELECT 1 FROM public.crm_loyalty_awards x WHERE x.customer_account_id=owner_id)
   OR EXISTS(SELECT 1 FROM public.crm_loyalty_reversals x WHERE x.customer_account_id=owner_id)
  THEN RAISE EXCEPTION 'MEMBER_LINK_IMPORTED_ACCOUNT_HAS_DATA';END IF;
  IF EXISTS(SELECT 1 FROM ada_history.member_links l LEFT JOIN ada_history.customers x USING(source_id,ada_code)
   WHERE l.member_id=owner_id AND(l.source_id<>'hq000/AdaAcc' OR x.active IS DISTINCT FROM '1' OR x.source_payload->>'FTCstBusiness' IS DISTINCT FROM '1'
    OR ada_history.local_member_phone(x.phone) NOT LIKE '%'||v_phone||'%'))
  THEN RAISE EXCEPTION 'MEMBER_LINK_IMPORTED_GROUP_REVIEW';END IF;
  UPDATE public.member_profiles SET member_code='MERGED-'||upper(left(replace(owner_id::text,'-',''),16)),is_active=false,
   remark=coalesce(remark,'')||E'\n'||jsonb_build_object('scope','SCCRM-EXACT-EXISTING-MEMBER-V1','memberId',p_member,
    'canonicalCode',p_code,'previousProfile',to_jsonb(old_profile),'nativeWrites',0)::text WHERE user_id=owner_id;
  UPDATE ada_history.member_links SET member_id=p_member,approval_reference=jsonb_build_object(
   'scope','SCCRM-EXACT-EXISTING-MEMBER-V1','previousMemberId',owner_id,'memberId',p_member,
   'canonicalCode',p_code,'previousApproval',approval_reference,'nativeWrites',0)::text WHERE member_id=owner_id;
 END IF;
 IF EXISTS(SELECT 1 FROM public.member_profiles m WHERE m.member_code=p_code AND m.user_id<>p_member)
  OR EXISTS(SELECT 1 FROM sccrm_member_codes.assignments a WHERE a.member_id=p_member OR a.ada_code=p_code)
 THEN RAISE EXCEPTION 'MEMBER_LINK_CANONICAL_OWNER_CONFLICT';END IF;
 IF EXISTS(SELECT 1 FROM ada_history.receipts r JOIN public.loyalty_claims lc
  ON upper(btrim(lc.branch_code))=upper(btrim(r.branch_code)) AND upper(btrim(lc.receipt_no))=upper(btrim(r.doc_no))
  WHERE r.source_id='hq000/AdaAcc' AND r.customer_code=p_code AND lc.user_id::text<>p_member::text)
 THEN RAISE EXCEPTION 'MEMBER_LINK_BILL_OWNER_CONFLICT';END IF;
 ref=jsonb_build_object('scope','SCCRM-EXACT-EXISTING-MEMBER-V1','mode',choice.resolution_mode,
  'memberId',p_member,'adaCode',p_code,'sourceHash',p_source_hash,'retiredImportedId',owner_id,'nativeWrites',0)::text;
 INSERT INTO ada_history.member_links(member_id,source_id,ada_code,approval_reference)
 VALUES(p_member,'hq000/AdaAcc',p_code,ref) ON CONFLICT(source_id,ada_code) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM ada_history.member_links l WHERE l.member_id=p_member AND l.source_id='hq000/AdaAcc' AND l.ada_code=p_code)
 THEN RAISE EXCEPTION 'MEMBER_LINK_CANONICAL_OWNER_CONFLICT';END IF;
 aid=gen_random_uuid();assigned=date_trunc('milliseconds',clock_timestamp());
 assigned_text=to_char(assigned AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 profile=jsonb_build_object('name',name,'phone',v_phone,'email',email);
 ph=encode(sha256(convert_to('{"email":'||to_json(email)::text||',"name":'||to_json(name)::text||',"phone":'||to_json(v_phone)::text||'}','UTF8')),'hex');
 ah=encode(sha256(convert_to('["SCCRM-HQ-MEMBER-CODE-AUTHORITY-V1",1,'||to_json(aid::text)::text||','||to_json(p_member::text)::text||','||to_json(p_code)::text||','||to_json(hq)::text||','||to_json(ph)::text||','||to_json(assigned_text)::text||',"approved_existing"]','UTF8')),'hex');
 INSERT INTO sccrm_member_codes.assignments(assignment_id,member_id,ada_code,hq_identity,profile_hash,profile,assigned_at,version,kind,deliver_to_branches,assignment_hash,authority_reference)
 VALUES(aid,p_member,p_code,hq,ph,profile,assigned,1,'approved_existing',false,ah,ref);
 INSERT INTO sccrm_member_codes.canonical_codes(member_id,assignment_id,canonical_code,publication_reference) VALUES(p_member,aid,p_code,ref);
 INSERT INTO sccrm_member_codes.aliases(code,member_id,assignment_id,reason,approval_reference)
 VALUES(old_code,p_member,aid,'LEGACY_SCCRM_MEMBER_CODE',ref);
 UPDATE public.member_profiles m SET member_code=p_code WHERE m.user_id=p_member AND m.member_code=old_code;
 INSERT INTO sccrm_member_codes.publication_events(assignment_id,member_id,code,previous_code,outcome)
 VALUES(aid,p_member,p_code,old_code,'published');
 RETURN QUERY SELECT 'linked'::text,p_code;
END $$;
REVOKE ALL ON FUNCTION ada_history.member_name_key(text),ada_history.local_member_phone(text),
 ada_history.existing_member_candidate(uuid),ada_history.pending_approved_member_links(integer),
 ada_history.resolve_existing_member(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ada_history.existing_member_candidate(uuid),
 ada_history.pending_approved_member_links(integer),ada_history.resolve_existing_member(uuid,text,text,text) TO sccrm_hq_live_sync;
