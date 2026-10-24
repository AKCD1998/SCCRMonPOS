'use strict';
const crypto=require('node:crypto');
const SOURCE='hq000/AdaAcc',MARKER='a3ec4bca-8488-4497-a89d-4c6090badbe0';
const digest=x=>crypto.createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
function canonical(x){if(Array.isArray(x))return x.map(canonical);if(x&&typeof x==='object')return Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]));return x;}
const hash=x=>digest(JSON.stringify(canonical(x)));
function text(v){return v==null?null:String(v);}
function required(v,code){const s=text(v);if(s==null||!s.trim())throw Error(code);return s;}
function identity(h){return [required(h.FTBchCode,'BRANCH_REQUIRED'),required(h.FTPosCode,'POS_REQUIRED'),required(h.FTShdDocType,'DOC_TYPE_REQUIRED'),required(h.FTShdDocNo,'DOC_REQUIRED')];}
function receiptKey(h){return hash(identity(h));}
function date(v){if(v==null)return null;const m=String(v).match(/^(\d{4})-(\d{2})-(\d{2})T/);if(!m)throw Error('SOURCE_DATE_INVALID');let y=Number(m[1]);if(y>=2400&&y<=2699)y-=543;return `${y}-${m[2]}-${m[3]}`;}
function time(v){if(v==null)return null;const s=String(v).trim();if(!/^\d{2}:\d{2}:\d{2}$/.test(s)||s.slice(0,2)>'23'||s.slice(3,5)>'59'||s.slice(6)>'59')throw Error('SOURCE_TIME_INVALID');return s;}
function numeric(v){if(v==null)return null;const s=String(v);if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(s)||!Number.isFinite(Number(s)))throw Error('SOURCE_NUMBER_INVALID');return s;}
function sequence(v){const s=String(v);if(!/^\d+$/.test(s)||BigInt(s)>9223372036854775807n)throw Error('SOURCE_SEQUENCE_INVALID');return s;}
function noPin(p){if(Object.keys(p).some(k=>/pin|password|token|secret/i.test(k)))throw Error('SENSITIVE_SOURCE_FIELD_REFUSED');}
function record(kind,p,headers){noPin(p);let key,owner,parent=null;
 if(kind==='customers'){key=required(p.FTCstCode,'CUSTOMER_CODE_REQUIRED');owner=key;}
 else if(kind==='receipts'){key=receiptKey(p);owner=required(p.FTCstCode,'CUSTOMER_CODE_REQUIRED');if(owner==='0'||!['1','9'].includes(p.FTShdDocType)||p.FTShdStaPaid!=='3')throw Error('NON_MEMBER_RECEIPT_REFUSED');}
 else if(kind==='lines'){const h=headers.get(p.FTShdDocNo);if(!h)throw Error('LINE_PARENT_REQUIRED');parent=receiptKey(h);owner=h.FTCstCode;if(p.FTBchCode&&p.FTBchCode!==h.FTBchCode)throw Error('LINE_BRANCH_MISMATCH');if(p.FTShdDocType&&p.FTShdDocType!==h.FTShdDocType)throw Error('LINE_TYPE_MISMATCH');key=hash([parent,sequence(p.FNSdtSeqNo)]);}
 else throw Error('SOURCE_KIND_INVALID');
 return {kind,key,keyHash:digest(key),owner,parent,payloadHash:hash(p),payload:p};
}
function validateConfig(c){if(c.scope!=='SCCRM-HISTORY-COPY-ONLY'||c.marker!==MARKER||c.sourceId!==SOURCE)throw Error('HISTORY_COPY_REQUIRED');if(c.pg?.host!=='127.0.0.1'||c.pg.port!==55444||c.pg.database!=='sccrm_ada_history_copy'||c.pg.user!=='sccrm_history_worker')throw Error('PRIVATE_HISTORY_POSTGRES_REQUIRED');if(c.sql?.database!=='SCCRM_UiSandbox_20261024_142127'||c.sql.user!=='sccrm_ui_20261024_142127'||c.sql.marker!=='6d42574b-3e90-4d92-aa5d-4c4920a08cbe'||!['tcp:100.90.166.72,49800','tcp:127.0.0.1,49800'].includes(c.sql.server))throw Error('SQL_COPY_REQUIRED');return c;}
module.exports={SOURCE,MARKER,canonical,hash,digest,text,identity,receiptKey,date,time,numeric,sequence,noPin,record,validateConfig};
