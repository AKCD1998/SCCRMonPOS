'use strict';
// Independent serial lanes. History I/O never occupies the member PG/SQL lane.
function configuration(c){
 const memberPollMs=c.memberPollMs??2000,historyPollMs=c.historyPollMs??300000,receiptPollMs=c.receiptPollMs??10000;
 if(!Number.isInteger(memberPollMs)||memberPollMs<1000||memberPollMs>10000
  ||!Number.isInteger(historyPollMs)||historyPollMs<300000||historyPollMs>3600000
  ||!Number.isInteger(receiptPollMs)||receiptPollMs<5000||receiptPollMs>60000)throw Error('LIVE_POLL_CONFIG_REFUSED');
 return {memberPollMs,historyPollMs,receiptPollMs};
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
