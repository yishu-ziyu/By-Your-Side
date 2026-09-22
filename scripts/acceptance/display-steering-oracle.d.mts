export interface DisplayAcceptanceRun {
  name:string;enabled:boolean;runId:string|null;conversationId:string;tabId:number;
  finalMatch:boolean;settle:string;sameRunId:boolean;conversationCountBefore:number;conversationCountAfter:number;
  deliveries:Array<{runId:string|null;conversationId:string;kind:string;text:string}>;
  steeringReceipt:{runId:string|null;action:string;status:string}|null;
  displayExecutions:Array<{id:string;params:Record<string,unknown>;ok:boolean;executionFact:string;tabId:number;document:string|null;runId:string|null}>;
  reTranslate:number;pageChangedMs:number|null;totalMs:number;direct:boolean;jevCalls:number;
}

export function median(values:ReadonlyArray<number|null|undefined>):number|null;
export function judgeDisplaySteeringRun(run:DisplayAcceptanceRun):{ok:boolean;checks:Record<string,boolean>;summary:string;failures:string[]};
export function summarizeDisplaySteering(runs:DisplayAcceptanceRun[],pairs:Array<{pair:number;arms:{on?:DisplayAcceptanceRun;off?:DisplayAcceptanceRun}}>,boundaries:Array<{failure:string|null}>):{
  pairs:number;runs:number;allRunsCorrect:boolean;boundaryFailures:number;testsAccountedFor:number;
  off:Record<string,unknown>;on:Record<string,unknown>;pairedObservations:Array<{pair:number;complete:boolean;deltaMs:number|null}>;
  pairedMedianDeltaMs:number|null;pairedMedianScope:string;
};
export function displayAcceptanceExitCode(input:{summary:{allRunsCorrect:boolean;boundaryFailures:number;pairs:number};smoke?:boolean;boundariesOnly?:boolean;boundaries?:Array<{failure:string|null}>;pairsExpected?:number|null}):number;
