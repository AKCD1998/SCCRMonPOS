'use strict';
// Independent serial lanes. History I/O never occupies the member PG/SQL lane.
function configuration(c){
 const memberPollMs=c.memberPollMs??2000,historyPollMs=c.historyPollMs??300000,receiptPollMs=c.receiptPollMs??10000;
 const branchHistoryEnabled=c.branchHistoryEnabled??false,branchHistoryBranches=c.branchHistoryBranches??['001','003','004','005'];
 const branchHistoryPollMs=c.branchHistoryPollMs??10000,branchHistoryFullPollMs=c.branchHistoryFullPollMs??300000;
 if(!Number.isInteger(memberPollMs)||memberPollMs<1000||memberPollMs>10000
  ||!Number.isInteger(historyPollMs)||historyPollMs<300000||historyPollMs>3600000
  ||!Number.isInteger(receiptPollMs)||receiptPollMs<5000||receiptPollMs>60000
  ||typeof branchHistoryEnabled!=='boolean'||!Array.isArray(branchHistoryBranches)||!branchHistoryBranches.length||new Set(branchHistoryBranches).size!==branchHistoryBranches.length||branchHistoryBranches.some(b=>!['001','003','004','005'].includes(b))
  ||!Number.isInteger(branchHistoryPollMs)||branchHistoryPollMs<5000||branchHistoryPollMs>60000
  ||!Number.isInteger(branchHistoryFullPollMs)||branchHistoryFullPollMs<300000||branchHistoryFullPollMs>3600000)throw Error('LIVE_POLL_CONFIG_REFUSED');
 return {memberPollMs,historyPollMs,receiptPollMs,branchHistoryEnabled,branchHistoryBranches,branchHistoryPollMs,branchHistoryFullPollMs};
}
async function runLane({cycle,intervalMs,stopping,sleep=ms=>new Promise(r=>setTimeout(r,ms)),onError=()=>{}}){
 while(!stopping()){
  try{await cycle();}catch(error){await onError(error);}
  let remaining=intervalMs;
  while(remaining>0&&!stopping()){const part=Math.min(remaining,250);await sleep(part);remaining-=part;}
 }
}
async function runLanes({memberCycle,historyCycle,memberPollMs,historyPollMs,stopping,sleep,onMemberError,onHistoryError}){
 return Promise.all([
  runLane({cycle:memberCycle,intervalMs:memberPollMs,stopping,sleep,onError:onMemberError}),
  runLane({cycle:historyCycle,intervalMs:historyPollMs,stopping,sleep,onError:onHistoryError}),
 ]);
}
module.exports={configuration,runLane,runLanes};
