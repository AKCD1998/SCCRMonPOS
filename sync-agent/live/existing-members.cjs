'use strict';
const crypto=require('node:crypto');
const {record,hash}=require('../history/model.cjs');
function digestMember(m){return hash({name:m.full_name,phone:m.phone_number,email:m.email});}
async function resolveExisting(pg,source,m,apply){
 const candidates=(await pg.query('SELECT * FROM ada_history.existing_member_candidate($1)',[m.id])).rows;
 if(!candidates.length)return null;
 if(candidates.length!==1||!/^AR(?:000|001|003|004|005)-[0-9]{6}$/.test(candidates[0].ada_code))throw Error('MEMBER_LINK_CANDIDATE_REFUSED');
 const code=candidates[0].ada_code,raw=(await source.query('customer',{code}));
 if(raw.length!==1||raw[0].FTCstCode!==code||Object.keys(raw[0]).length!==101)throw Error('MEMBER_LINK_NATIVE_SNAPSHOT_REFUSED');
 const snapshot=record('customers',raw[0]);
 await apply(pg,'customers',[snapshot],crypto.randomUUID(),code);
 const rows=(await pg.query('SELECT * FROM ada_history.resolve_existing_member($1,$2,$3,$4)',[m.id,code,snapshot.payloadHash,digestMember(m)])).rows;
 if(rows.length!==1||rows[0].member_code!==code||!['linked','already-linked'].includes(rows[0].state))throw Error('MEMBER_LINK_ACK_REFUSED');
 return {memberId:m.id,adaCode:code,state:rows[0].state};
}
module.exports={resolveExisting,digestMember};
