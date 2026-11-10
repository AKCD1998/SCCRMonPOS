-- Older already-authenticated POS devices can lack branch_id. Device identity
-- remains mandatory; if both branch values are present they must agree.
CREATE OR REPLACE FUNCTION ada_history.trusted_member_registration(p_member uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF session_user::text<>'sccrm_hq_live_sync' THEN RAISE EXCEPTION 'MEMBER_LINK_ACTOR_REFUSED';END IF;
 RETURN EXISTS(SELECT 1 FROM crm_reporting.member_registrations r JOIN public.users u ON u.id=r.member_id
  WHERE r.member_id=p_member AND(
   (r.source IN('pos','counter','staff')
    AND(r.branch_code IS NULL OR r.branch_code IN('001','003','004','005'))
    AND EXISTS(SELECT 1 FROM public.staff_devices d LEFT JOIN public.branches b ON b.id=d.branch_id
     WHERE d.device_id=r.device_id AND d.revoked_at IS NULL
      AND(r.branch_code IS NULL OR b.code IS NULL OR b.code=r.branch_code)))
   OR(r.source='qr' AND u.email IS NULL AND u.password_hash IS NULL AND u.is_verified=false
    AND NOT EXISTS(SELECT 1 FROM public.member_portal_sessions s WHERE s.user_id=u.id))
  ));
END $$;
REVOKE ALL ON FUNCTION ada_history.trusted_member_registration(uuid) FROM PUBLIC;
