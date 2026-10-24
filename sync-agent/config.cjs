'use strict';
const fs=require('node:fs');const path=require('node:path');
const DB='SCCRM_UiSandbox_20261024_142127',MARKER='6d42574b-3e90-4d92-aa5d-4c4920a08cbe';
function validate(c){
 if(c.scope!=='SCCRM-HQ-SANDBOX-ONLY'||c.sql?.database!==DB||c.sql.marker!==MARKER||c.sql.user!=='sccrm_ui_20261024_142127'||!['tcp:100.90.166.72,49800','tcp:127.0.0.1,49800'].includes(c.sql.server))throw Error('SANDBOX_TARGET_REQUIRED');
 if(c.pg?.host!=='127.0.0.1'||c.pg.port!==55443||c.pg.database!=='sccrm_hq_sync_copy'||c.pg.user!=='sccrm_sync_worker')throw Error('PRIVATE_POSTGRES_REQUIRED');
 if(!Number.isInteger(c.intervalMs)||c.intervalMs<1000||c.intervalMs>60000)throw Error('INVALID_INTERVAL');
 return c;
}
function read(file=process.env.SCCRM_SYNC_CONFIG||path.join(__dirname,'runtime/config.json')){return validate(JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')));}
module.exports={read,validate,DB,MARKER};
