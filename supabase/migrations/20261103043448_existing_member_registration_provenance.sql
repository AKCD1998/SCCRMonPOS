-- Unattended identity matching must not turn a self-claimed email/login into
-- access to an old customer's purchase history. Staff-device provenance or a
-- login-free public QR contact is required. Explicit admin links remain valid.
CREATE FUNCTION ada_history.trusted_member_registration(p_member uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF session_user::text<>'sccrm_hq_live_sync' THEN RAISE EXCEPTION 'MEMBER_LINK_ACTOR_REFUSED';END IF;
 RETURN EXISTS(SELECT 1 FROM crm_reporting.member_registrations r JOIN public.users u ON u.id=r.member_id
  WHERE r.member_id=p_member AND(
   (r.source IN('pos','counter','staff') AND r.branch_code IN('001','003','004','005')
    AND EXISTS(SELECT 1 FROM public.staff_devices d JOIN public.branches b ON b.id=d.branch_id
     WHERE d.device_id=r.device_id AND d.revoked_at IS NULL AND b.code=r.branch_code))
   OR(r.source='qr' AND u.email IS NULL AND u.password_hash IS NULL AND u.is_verified=false
    AND NOT EXISTS(SELECT 1 FROM public.member_portal_sessions s WHERE s.user_id=u.id))
  ));
END $$;
REVOKE ALL ON FUNCTION ada_history.trusted_member_registration(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION ada_history.existing_member_candidate(p_member uuid)
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
 IF NOT ada_history.trusted_member_registration(p_member) THEN RETURN;END IF;
 WITH candidates AS (
  SELECT c.ada_code,l.member_id FROM ada_history.customers c
  LEFT JOIN ada_history.member_links l USING(source_id,ada_code)
  WHERE c.source_id='hq000/AdaAcc' AND c.active='1'
   AND c.ada_code ~ '^AR(000|001|003|004|005)-[0-9]{6}$'
   AND c.source_payload->>'FTCstBusiness'='1'
   AND coalesce(c.source_payload->>'FTCstTaxNo','') !~ '[1-9]'
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
   AND coalesce(c.source_payload->>'FTCstTaxNo','') !~ '[1-9]'
  AND ada_history.member_name_key(c.name)=ada_history.member_name_key(u.full_name)
  AND ada_history.local_member_phone(c.phone) LIKE '%'||ada_history.local_member_phone(u.phone_number)||'%'
  AND(NULLIF(lower(btrim(c.email)),'') IS NULL OR NULLIF(lower(btrim(u.email)),'') IS NULL OR lower(btrim(c.email))=lower(btrim(u.email)))
  AND(u.dob IS NULL OR NULLIF(c.source_payload->>'FDCstDob','') IS NULL
   OR left(c.source_payload->>'FDCstDob',10)=u.dob::text OR left(c.source_payload->>'FDCstDob',10)=left(c.source_payload->>'FDDateIns',10))
  AND(NULLIF(u.sex,'') IS NULL OR NULLIF(c.source_payload->>'FTCstSex','') IS NULL OR u.sex=c.source_payload->>'FTCstSex')
  AND NOT EXISTS(SELECT 1 FROM sccrm_member_codes.assignments a2 WHERE a2.member_id=owner_id OR a2.ada_code=m.member_code);
 IF FOUND THEN RETURN QUERY SELECT code,'imported'::text,owner_id;END IF;
END $$;

REVOKE ALL ON FUNCTION ada_history.existing_member_candidate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ada_history.existing_member_candidate(uuid),ada_history.resolve_existing_member(uuid,text,text,text) TO sccrm_hq_live_sync;
